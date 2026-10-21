YOUTUBE_IPA := ./ipa/YouTube_4.54.01_decrypted.ipa
OUTPUT_IPA := ./mutube.ipa
PATCHER_FLAGS :=

ifneq ($(PRINTF_LOGS),)
ifneq ($(PRINTF_LOGS),0)
PATCHER_FLAGS += --enable-printf-logs
endif
endif

ifneq ($(KEEP_SUPPORTED_DEVICES),)
ifneq ($(KEEP_SUPPORTED_DEVICES),0)
PATCHER_FLAGS += --keep-supported-devices
endif
endif

.PHONY: all
all: $(OUTPUT_IPA)

$(OUTPUT_IPA): $(YOUTUBE_IPA) patcher.py inject.js
	uv run patcher.py --in $(YOUTUBE_IPA) --out $(OUTPUT_IPA) $(PATCHER_FLAGS)

.PHONY: clean
clean:
	rm -f $(OUTPUT_IPA)
