#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = [
#     "capstone>=5.0.6",
#     "lief>=0.17.3",
# ]
# ///
import argparse
import subprocess
import struct
import tempfile
import zipfile
from pathlib import Path

import lief
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN

YTTV_NEEDLE = b"yttv"
CSP_PREFIX = b"sponsorblock.inf.re sponsor.ajay.app dearrow-thumb.ajay.app cdn.jsdelivr.net "
LOG_HTML_ENTRY = b"MUTUBE_HTMLSCRIPT ra=%p\n"
LOG_HTML_INJECT = b"MUTUBE_HTMLSCRIPT injected\n"
LOG_CSP_ENTRY = b"MUTUBE_CSP ra=%p\n"
LOG_CSP_INJECT = b"MUTUBE_CSP injected\n"
# Bytes reserved on stack for saved GP registers in save_regs()/restore_regs().
SAVE_SIZE = 0xB0
# Register pairs saved/restored by stubs; order defines stack slot offsets.
REG_PAIRS = [(0, 1), (2, 3), (4, 5), (6, 7), (8, 9), (10, 11), (12, 13), (14, 15), (16, 17), (18, 19), (29, 30)]

# 4.54.01 only. Store function entry VAs and derive patch sites by skipping
# the stack/frame prologue at runtime.
# We do not patch entry directly: our BL->stub->ret flow must run after prologue.
PATCHES = [
    {
        "name": "htmlscript",
        "kind": "html",
        "entry_va": 0x100EBD830,
        "expect": ("ldrb", "w8, [x0, #0x4b0]"),
    },
    {
        "name": "csp",
        "kind": "csp",
        "entry_va": 0x101515AC8,
        "expect": ("mov", "x21, x2"),
    },
]

COBALT_HOOKS = [
    {
        "name": "cobalt_vp9_profile2_support",
        "kind": "media_support",
        "entry_va": 0x101180894,
        "expect": ("mov", "x20, x1"),
    },
]

# YouTube 4.54.01 Cobalt gates used by the tvOS HDR output path. The patches
# keep the app's existing AVDisplayCriteria and VP9 Profile 2 flow active after
# the IPA is re-signed.
COBALT_HDR_PATCHES = [
    {
        "name": "cobalt_display_criteria_gate",
        "va": 0x101142BE4,
        "expect": ("cbz", "w0, #0x101142d0c"),
        "replacement": 0xD503201F,  # nop
    },
    {
        "name": "cobalt_vp9_hdr_hw_gate",
        "va": 0x10114F840,
        "expect": ("cbz", "w0, #0x10114f874"),
        "replacement": 0xD503201F,  # nop
    },
    {
        "name": "cobalt_vp9_hdr_4k60_gate",
        "va": 0x10114F870,
        "expect": ("b", "#0x10114f730"),
        "replacement": 0x14000009,  # b 0x10114f894 (supported)
    },
]

MD = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
MD.detail = False


def encode_bl(src_pc, dst):
    # Encode a direct ARM64 BL from src_pc to dst.
    off = dst - src_pc
    if off % 4:
        raise ValueError("bl target must be 4-byte aligned")
    imm26 = off >> 2
    if not (-(1 << 25) <= imm26 < (1 << 25)):
        raise ValueError("bl target out of range")
    return 0x94000000 | (imm26 & 0x03FFFFFF)


def read_u32(data, off):
    return struct.unpack_from("<I", data, off)[0]


def disasm_one(code, va):
    ins = next(MD.disasm(code, va), None)
    if ins is None:
        raise ValueError("failed to disassemble instruction")
    return ins


def asm_lines(lines):
    # Assemble ARM64 source with Apple's assembler and return __text bytes only.
    asm_text = ".text\n.align 2\n" + "\n".join(lines) + "\n"
    with tempfile.TemporaryDirectory() as tmpdir:
        asm_path = Path(tmpdir) / "stub.s"
        obj_path = Path(tmpdir) / "stub.o"
        asm_path.write_text(asm_text)
        cmd = [
            "xcrun",
            "--sdk",
            "appletvos",
            "clang",
            "-c",
            "-target",
            "arm64-apple-tvos",
            "-x",
            "assembler",
            "-o",
            str(obj_path),
            str(asm_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        obj = lief.parse(str(obj_path))
        text = obj.get_section("__text")
        if not text:
            raise ValueError("assembled object has no __text section")
        return bytes(text.content)


def mov64(reg, value):
    # Materialize a 64-bit immediate in a register.
    return [
        f"movz {reg}, #0x{value & 0xFFFF:x}",
        f"movk {reg}, #0x{(value >> 16) & 0xFFFF:x}, lsl #16",
        f"movk {reg}, #0x{(value >> 32) & 0xFFFF:x}, lsl #32",
        f"movk {reg}, #0x{(value >> 48) & 0xFFFF:x}, lsl #48",
    ]


def load_addr(reg, value, slide_reg="x19"):
    # Load link-time VA and add ASLR slide stored in slide_reg.
    return [*mov64(reg, value), f"add {reg}, {reg}, {slide_reg}"]


def save_regs():
    # Save caller-visible GP state we might clobber in hook logic.
    out = [f"sub sp, sp, #0x{SAVE_SIZE:x}"]
    for i, (a, b) in enumerate(REG_PAIRS):
        out.append(f"stp x{a}, x{b}, [sp, #0x{i * 0x10:x}]")
    return out


def restore_regs():
    # Restore in reverse order of save_regs(), then release stub stack frame.
    out = []
    for i, (a, b) in reversed(list(enumerate(REG_PAIRS))):
        out.append(f"ldp x{a}, x{b}, [sp, #0x{i * 0x10:x}]")
    out.append(f"add sp, sp, #0x{SAVE_SIZE:x}")
    return out


def load_payload():
    # Payload is source-of-truth JS kept in a dedicated file.
    # Ignore full-line // comments so notes can live in inject.js without
    # being embedded into the runtime payload.
    text = Path(__file__).with_name("inject.js").read_text(encoding="ascii")
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("//")]
    cleaned = "\n".join(lines).strip()
    if not cleaned:
        raise ValueError("inject.js is empty")
    return cleaned.encode("ascii")


def parse_macho_info(data):
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir) / "input.macho"
        tmp_path.write_bytes(data)
        binary = lief.parse(str(tmp_path))

    # We patch instructions in __text and store new data/stubs in header padding
    # inside __TEXT (between Mach-O load commands and __text start).
    text = binary.get_section("__text")
    stubs = binary.get_section("__stubs")
    text_seg = next((s for s in binary.segments if s.name == "__TEXT"), None)
    dysym = next((c for c in binary.commands if type(c).__name__ == "DynamicSymbolCommand"), None)
    if not text or not stubs or not text_seg or not dysym:
        raise ValueError("required Mach-O structures missing (__TEXT/__text/__stubs/dysymtab)")

    return {
        "text_va": text.virtual_address,
        "text_off": text.offset,
        "text_size": text.size,
        "text_seg_va": text_seg.virtual_address,
        "text_seg_off": text_seg.file_offset,
        "header_end": 32 + binary.header.sizeof_cmds,
        "stubs": stubs,
        "dysym": dysym,
    }


def va_to_off(info, va):
    # Convert __text virtual address to file offset with bounds check.
    off = info["text_off"] + (va - info["text_va"])
    if off < info["text_off"] or off + 4 > info["text_off"] + info["text_size"]:
        raise ValueError(f"VA out of __text bounds: {hex(va)}")
    return off


def is_prologue_insn(ins):
    # Heuristic for common ARM64 function-prologue instructions.
    m, o = ins.mnemonic, ins.op_str
    if m in {"pacibsp", "bti", "nop", "hint"}:
        return True
    if m == "sub" and o.startswith("sp, sp, #"):
        return True
    if m == "stp" and "[sp" in o:
        return True
    if m == "add" and o.startswith("x29, sp, #"):
        return True
    if m == "mov" and o == "x29, sp":
        return True
    return False


def resolve_patch_site(data, info, entry_va, max_scan=24):
    # Starting at function entry, skip prologue and return first body instruction.
    entry_off = va_to_off(info, entry_va)
    first = disasm_one(data[entry_off:entry_off + 4], entry_va)
    if not is_prologue_insn(first):
        raise ValueError(f"entry {hex(entry_va)} is not a prologue start ({first.mnemonic} {first.op_str})")

    for i in range(1, max_scan + 1):
        site_va = entry_va + i * 4
        site_off = va_to_off(info, site_va)
        ins = disasm_one(data[site_off:site_off + 4], site_va)
        if not is_prologue_insn(ins):
            return site_va, site_off, read_u32(data, site_off), ins

    raise ValueError(f"failed to find first non-prologue instruction after {hex(entry_va)}")


def resolve_stub_va(info, symbol_name):
    # Resolve imported symbol trampoline VA from __stubs + indirect symbols.
    stubs = info["stubs"]
    dysym = info["dysym"]
    stub_size = stubs.reserved2
    if stub_size == 0:
        raise ValueError("__stubs has zero stub size")

    for i in range(stubs.size // stub_size):
        sym = dysym.indirect_symbols[stubs.reserved1 + i]
        if getattr(sym, "name", None) == symbol_name:
            return stubs.virtual_address + i * stub_size
    raise ValueError(f"stub not found for symbol {symbol_name}")


class Allocator:
    # Tiny bump allocator for header padding region.
    def __init__(self, start, end):
        self.cursor = start
        self.end = end

    def alloc(self, size, align=1):
        self.cursor = (self.cursor + align - 1) & ~(align - 1)
        off = self.cursor
        self.cursor += size
        if self.cursor > self.end:
            raise ValueError("patch region out of space")
        return off


def emit_log(addrs, key, include_ra, enabled):
    # Optional printf logging path, compiled out of stubs by default.
    if not enabled:
        return []
    lines = [*load_addr("x0", addrs[key])]
    if include_ra:
        lines.append("mov x1, x30")
    lines += [*load_addr("x16", addrs["printf"]), "blr x16"]
    return lines


def build_stub(kind, stub_va, addrs, orig_ins, enable_printf_logs):
    # Build one hook stub:
    # 1) save regs
    # 2) compute ASLR slide
    # 3) run hook logic
    # 4) restore regs + replay displaced instruction + ret
    label = f"stub_{kind}"
    stub_page = stub_va & ~0xFFF

    # Stub entry label + common prologue (alloc frame + spill GP state).
    lines = [f"{label}:", *save_regs()]
    lines += [
        # Runtime page of this label (ADR resolves with current ASLR slide).
        f"adr x17, {label}",
        # Keep just the page address for slide math.
        "and x17, x17, #0xfffffffffffff000",
        # Link-time page where this stub was placed in the file.
        *mov64("x16", stub_page),
        # slide = runtime_page - linktime_page
        "sub x17, x17, x16",
        # Keep slide in a callee-saved register used by load_addr().
        "mov x19, x17",
    ]

    if kind == "html":
        # HTMLScriptElement::Execute:
        # - x1 (saved at [sp+0x08]) is std::string* content
        # - inject only if content contains "yttv"
        lines += [
            *emit_log(addrs, "log_html_entry", include_ra=True, enabled=enable_printf_logs),
            "ldr x0, [sp, #0x08]",
            *load_addr("x1", addrs["yttv"]),
            "mov x2, #0",
            *mov64("x3", addrs["yttv_len"]),
            *load_addr("x16", addrs["find"]),
            "blr x16",
            "cmn x0, #1",
            "b.eq html_skip",
            "ldr x0, [sp, #0x08]",
            "mov x1, #0",
            *load_addr("x2", addrs["inject"]),
            *mov64("x3", addrs["inject_len"]),
            *load_addr("x16", addrs["insert"]),
            "blr x16",
            *emit_log(addrs, "log_html_inject", include_ra=False, enabled=enable_printf_logs),
            "html_skip:",
        ]
    elif kind == "csp":
        # DirectiveList::AddDirective:
        # - x2 (saved at [sp+0x10]) is std::string* directive value
        # - always prepend CSP whitelist domains
        lines += [
            *emit_log(addrs, "log_csp_entry", include_ra=True, enabled=enable_printf_logs),
            "ldr x0, [sp, #0x10]",
            "mov x1, #0",
            *load_addr("x2", addrs["csp"]),
            *mov64("x3", addrs["csp_len"]),
            *load_addr("x16", addrs["insert"]),
            "blr x16",
            *emit_log(addrs, "log_csp_inject", include_ra=False, enabled=enable_printf_logs),
        ]
    elif kind == "media_support":
        # Re-signed builds can reject VP9 Profile 2 before YouTube exposes HDR
        # formats. Report probable support only for Profile 2 MIME strings when
        # AVPlayer confirms HDR playback eligibility. Missing APIs, SDR-only
        # hardware, and every other codec fall through to Cobalt unchanged.
        lines += [
            "ldr x0, [sp]",
            *load_addr("x1", addrs["vp9_profile2_full"]),
            *load_addr("x16", addrs["strstr"]),
            "blr x16",
            "cbnz x0, media_profile2_check_hdr",
            "ldr x0, [sp]",
            *load_addr("x1", addrs["vp9_profile2_short"]),
            *load_addr("x16", addrs["strstr"]),
            "blr x16",
            "cbz x0, media_profile2_continue",
            "media_profile2_check_hdr:",
            *load_addr("x0", addrs["avplayer_class_name"]),
            *load_addr("x16", addrs["objc_get_class"]),
            "blr x16",
            "cbz x0, media_profile2_continue",
            "mov x20, x0",
            "movn x0, #1",
            *load_addr("x1", addrs["sel_register_name_symbol"]),
            *load_addr("x16", addrs["dlsym"]),
            "blr x16",
            "cbz x0, media_profile2_continue",
            "mov x16, x0",
            *load_addr("x0", addrs["hdr_eligible_selector"]),
            "blr x16",
            "cbz x0, media_profile2_continue",
            "mov x21, x0",
            "movn x0, #1",
            *load_addr("x1", addrs["class_get_method_symbol"]),
            *load_addr("x16", addrs["dlsym"]),
            "blr x16",
            "cbz x0, media_profile2_continue",
            "mov x16, x0",
            "mov x0, x20",
            "mov x1, x21",
            "blr x16",
            "cbz x0, media_profile2_continue",
            "mov x0, x20",
            "mov x1, x21",
            *load_addr("x16", addrs["objc_msg_send"]),
            "blr x16",
            "tbz w0, #0, media_profile2_continue",
            "media_profile2_supported:",
            *restore_regs(),
            "mov w0, #2",
            "ldp x29, x30, [sp, #0x130]",
            "ldp x20, x19, [sp, #0x120]",
            "ldp x22, x21, [sp, #0x110]",
            "ldp x28, x27, [sp, #0x100]",
            "add sp, sp, #0x140",
            "ret",
            "media_profile2_continue:",
        ]
    else:
        raise ValueError(f"unknown stub kind: {kind}")

    lines += [*restore_regs(), f".word 0x{orig_ins:08x}", "ret"]
    return asm_lines(lines)


def patch_binary(data, enable_printf_logs=False):
    info = parse_macho_info(data)
    start, end = info["header_end"], info["text_off"]
    if start >= end:
        raise ValueError("no __TEXT padding available for stubs")
    alloc = Allocator(start, end)

    def put(blob, align=4):
        off = alloc.alloc(len(blob), align)
        data[off:off + len(blob)] = blob
        return off

    js = load_payload()
    # Embed runtime strings and payload in __TEXT header padding.
    offs = {
        "yttv": put(YTTV_NEEDLE + b"\0"),
        "inject": put(js + b"\0"),
        "csp": put(CSP_PREFIX + b"\0"),
        "vp9_profile2_full": put(b"vp09.02\0"),
        "vp9_profile2_short": put(b"vp9.2\0"),
        "avplayer_class_name": put(b"AVPlayer\0"),
        "sel_register_name_symbol": put(b"sel_registerName\0"),
        "class_get_method_symbol": put(b"class_getClassMethod\0"),
        "hdr_eligible_selector": put(b"eligibleForHDRPlayback\0"),
    }
    if enable_printf_logs:
        offs |= {
            "log_html_entry": put(LOG_HTML_ENTRY + b"\0"),
            "log_html_inject": put(LOG_HTML_INJECT + b"\0"),
            "log_csp_entry": put(LOG_CSP_ENTRY + b"\0"),
            "log_csp_inject": put(LOG_CSP_INJECT + b"\0"),
        }
    alloc.alloc(0, 16)

    f2v = lambda off: info["text_seg_va"] + (off - info["text_seg_off"])
    addrs = {k: f2v(v) for k, v in offs.items()}
    addrs |= {
        "yttv_len": len(YTTV_NEEDLE),
        "inject_len": len(js),
        "csp_len": len(CSP_PREFIX),
        "find": resolve_stub_va(info, "__ZNKSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE4findEPKcmm"),
        "insert": resolve_stub_va(info, "__ZNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE6insertEmPKcm"),
        "strstr": resolve_stub_va(info, "_strstr"),
        "objc_get_class": resolve_stub_va(info, "_objc_getClass"),
        "objc_msg_send": resolve_stub_va(info, "_objc_msgSend"),
        "dlsym": resolve_stub_va(info, "_dlsym"),
    }
    if enable_printf_logs:
        addrs["printf"] = resolve_stub_va(info, "_printf")

    # Resolve final patch sites dynamically from function entry + prologue scan.
    resolved = []
    for p in PATCHES + COBALT_HOOKS:
        site_va, site_off, orig_ins, insn = resolve_patch_site(data, info, p["entry_va"])
        if (insn.mnemonic, insn.op_str) != p["expect"]:
            raise ValueError(
                f"{p['name']}: at {hex(site_va)} expected {p['expect'][0]} {p['expect'][1]}, got {insn.mnemonic} {insn.op_str}"
            )
        resolved.append({**p, "site_va": site_va, "site_off": site_off, "orig": orig_ins})

    # Two-pass stub build:
    # pass 1 determines byte lengths; pass 2 assembles with final VAs.
    stubs = {}
    for p in resolved:
        stubs[p["name"]] = {"len": len(build_stub(p["kind"], 0, addrs, p["orig"], enable_printf_logs))}
    for p in resolved:
        off = alloc.alloc(stubs[p["name"]]["len"], 4)
        stubs[p["name"]] |= {"off": off, "va": f2v(off)}
    for p in resolved:
        stubs[p["name"]]["blob"] = build_stub(p["kind"], stubs[p["name"]]["va"], addrs, p["orig"], enable_printf_logs)

    out = []
    for p in resolved:
        s = stubs[p["name"]]
        data[s["off"]:s["off"] + len(s["blob"])] = s["blob"]
        # Overwrite target instruction with BL to stub.
        data[p["site_off"]:p["site_off"] + 4] = struct.pack("<I", encode_bl(p["site_va"], s["va"]))
        out.append(
            {
                "name": p["name"],
                "entry_va": p["entry_va"],
                "patch_site_va": p["site_va"],
                "stub_va": s["va"],
                "stub_len": len(s["blob"]),
            }
        )

    for patch in COBALT_HDR_PATCHES:
        patch_off = va_to_off(info, patch["va"])
        insn = disasm_one(data[patch_off:patch_off + 4], patch["va"])
        if (insn.mnemonic, insn.op_str) != patch["expect"]:
            raise ValueError(
                f"{patch['name']}: at {hex(patch['va'])} expected "
                f"{patch['expect'][0]} {patch['expect'][1]}, got "
                f"{insn.mnemonic} {insn.op_str}"
            )
        data[patch_off:patch_off + 4] = struct.pack("<I", patch["replacement"])
        out.append(
            {
                "name": patch["name"],
                "entry_va": patch["va"],
                "patch_site_va": patch["va"],
                "stub_va": 0,
                "stub_len": 0,
            }
        )

    return out


def patch_ipa(in_path, out_path, enable_printf_logs=False):
    # Replace only app binary inside IPA; preserve all other entries.
    with zipfile.ZipFile(in_path, "r") as zin:
        infos = zin.infolist()
        bin_info = next((i for i in infos if i.filename.endswith("/YouTubeUnstable")), None)
        if not bin_info:
            raise ValueError("YouTubeUnstable binary not found in IPA")

        binary = bytearray(zin.read(bin_info.filename))
        meta = patch_binary(binary, enable_printf_logs=enable_printf_logs)

        with zipfile.ZipFile(out_path, "w") as zout:
            for info in infos:
                payload = binary if info.filename == bin_info.filename else zin.read(info.filename)
                zout.writestr(info, payload)
    return meta


def main():
    ap = argparse.ArgumentParser(description="MuTube patcher (YouTube 4.54.01)")
    ap.add_argument("--in", dest="inp", required=True, help="input IPA path")
    ap.add_argument("--out", dest="outp", required=True, help="output IPA path")
    ap.add_argument(
        "--enable-printf-logs",
        action="store_true",
        help="enable MUTUBE_* printf logs in hook stubs (disabled by default)",
    )
    args = ap.parse_args()

    meta = patch_ipa(args.inp, args.outp, enable_printf_logs=args.enable_printf_logs)
    print("Patched IPA written to:", args.outp)
    for entry in meta:
        print("Patch:", entry["name"])
        print("  Entry VA:", hex(entry["entry_va"]))
        print("  Patch site VA:", hex(entry["patch_site_va"]))
        print("  Stub VA:", hex(entry["stub_va"]), "len", entry["stub_len"])


if __name__ == "__main__":
    main()
