FRIDA_VERSION := 17.3.0
YOUTUBE_IPA := ./ipa/YouTube_4.51.08_decrypted.ipa
GUM_GRAFT := ./bin/gum-graft-$(FRIDA_VERSION)-macos-arm64

.PHONY: all
all: mutube.ipa

$(GUM_GRAFT):
	@echo "Downloading gum-graft..."
	mkdir -p ./bin
	wget https://github.com/frida/frida/releases/download/$(FRIDA_VERSION)/gum-graft-$(FRIDA_VERSION)-macos-arm64.xz -P ./bin
	unxz -k ./bin/gum-graft-$(FRIDA_VERSION)-macos-arm64.xz
	chmod +x ./bin/gum-graft-$(FRIDA_VERSION)-macos-arm64

mutube.ipa: $(YOUTUBE_IPA) $(GUM_GRAFT) main.js script_config.json
	$(eval TMPDIR := $(shell mktemp -d ./.make-tmp_XXXXXXXX))

	wget -q https://github.com/frida/frida/releases/download/$(FRIDA_VERSION)/frida-gadget-$(FRIDA_VERSION)-tvos-arm64.dylib.xz -O $(TMPDIR)/frida-gadget.dylib.xz
	unxz -k $(TMPDIR)/frida-gadget.dylib.xz
	mkdir -p $(TMPDIR)/yt-unzip
	unzip -q $(YOUTUBE_IPA) -d $(TMPDIR)/yt-unzip
	mv $(TMPDIR)/frida-gadget.dylib $(TMPDIR)/yt-unzip/Payload/YouTubeUnstable.app/Frameworks/FridaGadget.dylib
	cp ./script_config.json $(TMPDIR)/yt-unzip/Payload/YouTubeUnstable.app/FridaGadget.config
	cp ./main.js $(TMPDIR)/yt-unzip/Payload/YouTubeUnstable.app/main.js
	$(GUM_GRAFT) $(TMPDIR)/yt-unzip/Payload/YouTubeUnstable.app/YouTubeUnstable --instrument=0xed5270 --instrument=0x152d508
	insert_dylib --strip-codesig --inplace '@executable_path/Frameworks/FridaGadget.dylib' $(TMPDIR)/yt-unzip/Payload/YouTubeUnstable.app/YouTubeUnstable
	cd $(TMPDIR)/yt-unzip && zip -qr injected.ipa Payload
	mv $(TMPDIR)/yt-unzip/injected.ipa mutube.ipa

	rm -rf $(TMPDIR)

.PHONY: clean
clean:
	rm -rf ./.make-tmp_* mutube.ipa
