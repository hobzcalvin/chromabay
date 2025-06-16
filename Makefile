CC = gcc
CFLAGS = -Wall -std=c99
LIBS = -lmbedcrypto

# Source files
SOURCES = test_signature_verification.c test_signature_verification_fixed.c test_signature_verification_mbedtls.c
TARGETS = $(SOURCES:.c=)

# PSA tools
PSA_TOOLS = psa_sign_firmware test_psa_end_to_end compare_psa_python_signatures
PSA_CONVERSION_TOOLS = convert_key_to_raw.py

# Default target
all: $(TARGETS) psa_tools

# Compile individual test programs
%: %.c
	$(CC) $(CFLAGS) $< $(LIBS) -o $@

# PSA tools
psa_tools: $(PSA_TOOLS)

psa_sign_firmware: psa_sign_firmware.c
	$(CC) $(CFLAGS) $< $(LIBS) -o $@

test_psa_end_to_end: test_psa_end_to_end.c
	$(CC) $(CFLAGS) $< $(LIBS) -o $@

compare_psa_python_signatures: compare_psa_python_signatures.c
	$(CC) $(CFLAGS) $< $(LIBS) -o $@

# Test PSA signing workflow
test_psa_workflow: psa_sign_firmware
	@echo "=== Testing PSA Signing Workflow ==="
	@if [ ! -f "keys/esp32-signing-private.pem" ]; then \
		echo "❌ Private key not found. Run scripts/generate-signing-keys.sh first"; \
		exit 1; \
	fi
	@echo "1. Converting PEM key to raw format..."
	python3 convert_key_to_raw.py keys/esp32-signing-private.pem test_private_key.raw
	@echo "2. Signing test firmware..."
	./psa_sign_firmware firmware.bin test_private_key.raw test_psa_signature.sig
	@echo "3. Verifying signature..."
	$(CC) $(CFLAGS) test_psa_end_to_end.c $(LIBS) -o test_psa_verification_temp
	@mv test_psa_signature.sig psa_test_signature.sig  # Match expected filename
	./test_psa_verification_temp
	@echo "✅ PSA workflow test complete!"
	@rm -f test_private_key.raw test_psa_verification_temp

# Clean compiled files
clean:
	rm -f $(TARGETS) $(PSA_TOOLS)
	rm -f *.sig *.raw
	rm -f test_*

# Install dependencies (for development)
install_deps:
	@echo "Installing mbedTLS development libraries..."
	@if command -v apt-get >/dev/null 2>&1; then \
		sudo apt-get update && sudo apt-get install -y libmbedtls-dev; \
	elif command -v brew >/dev/null 2>&1; then \
		brew install mbedtls; \
	else \
		echo "❌ Please install mbedTLS development libraries manually"; \
		echo "Ubuntu/Debian: sudo apt-get install libmbedtls-dev"; \
		echo "macOS: brew install mbedtls"; \
		exit 1; \
	fi

.PHONY: all psa_tools test_psa_workflow clean install_deps 