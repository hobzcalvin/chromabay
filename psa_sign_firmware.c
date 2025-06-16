#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include "psa/crypto.h"

#define MAX_FIRMWARE_SIZE (2 * 1024 * 1024) // 2MB max firmware size
#define SIGNATURE_SIZE 64
#define HASH_SIZE 32

void print_usage(const char* program_name) {
    printf("PSA Firmware Signing Tool\n");
    printf("Usage: %s <firmware.bin> <private_key.raw> <output.sig>\n", program_name);
    printf("\nArguments:\n");
    printf("  firmware.bin    - Input firmware binary file\n");
    printf("  private_key.raw - Private key in raw 32-byte format\n");
    printf("  output.sig      - Output signature file (64 bytes)\n");
    printf("\nExample:\n");
    printf("  %s firmware.bin private_key.raw firmware.sig\n", program_name);
    printf("\nNote: Private key must be in raw 32-byte big-endian format\n");
    printf("      Convert from PEM using: openssl ec -in key.pem -noout -text\n");
}

uint8_t* read_file(const char* filename, size_t* size) {
    FILE* file = fopen(filename, "rb");
    if (!file) {
        printf("❌ Error: Cannot open file '%s'\n", filename);
        return NULL;
    }
    
    // Get file size
    fseek(file, 0, SEEK_END);
    *size = ftell(file);
    fseek(file, 0, SEEK_SET);
    
    if (*size == 0) {
        printf("❌ Error: File '%s' is empty\n", filename);
        fclose(file);
        return NULL;
    }
    
    if (*size > MAX_FIRMWARE_SIZE) {
        printf("❌ Error: File '%s' is too large (%zu bytes, max %d)\n", 
               filename, *size, MAX_FIRMWARE_SIZE);
        fclose(file);
        return NULL;
    }
    
    // Allocate and read
    uint8_t* buffer = malloc(*size);
    if (!buffer) {
        printf("❌ Error: Cannot allocate memory for file '%s'\n", filename);
        fclose(file);
        return NULL;
    }
    
    if (fread(buffer, 1, *size, file) != *size) {
        printf("❌ Error: Cannot read file '%s'\n", filename);
        free(buffer);
        fclose(file);
        return NULL;
    }
    
    fclose(file);
    return buffer;
}

bool write_file(const char* filename, const uint8_t* data, size_t size) {
    FILE* file = fopen(filename, "wb");
    if (!file) {
        printf("❌ Error: Cannot create file '%s'\n", filename);
        return false;
    }
    
    if (fwrite(data, 1, size, file) != size) {
        printf("❌ Error: Cannot write to file '%s'\n", filename);
        fclose(file);
        return false;
    }
    
    fclose(file);
    return true;
}

void print_hex(const char* label, const uint8_t* data, size_t len) {
    printf("%s: ", label);
    for (size_t i = 0; i < len; i++) {
        printf("%02x", data[i]);
    }
    printf("\n");
}

bool sign_firmware_with_psa(const uint8_t* firmware_data, size_t firmware_size,
                           const uint8_t* private_key, uint8_t* signature) {
    psa_status_t status;
    psa_key_id_t key_id;
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    uint8_t firmware_hash[HASH_SIZE];
    size_t hash_length;
    size_t signature_length;
    bool success = false;
    
    printf("🔐 Signing firmware with PSA Crypto...\n");
    
    // Initialize PSA Crypto
    status = psa_crypto_init();
    if (status != PSA_SUCCESS) {
        printf("❌ PSA crypto initialization failed: %d\n", (int)status);
        return false;
    }
    printf("✅ PSA crypto initialized\n");
    
    // Calculate SHA-256 hash of firmware
    status = psa_hash_compute(PSA_ALG_SHA_256, firmware_data, firmware_size,
                             firmware_hash, sizeof(firmware_hash), &hash_length);
    if (status != PSA_SUCCESS) {
        printf("❌ Hash calculation failed: %d\n", (int)status);
        return false;
    }
    
    if (hash_length != HASH_SIZE) {
        printf("❌ Hash length mismatch: got %zu, expected %d\n", hash_length, HASH_SIZE);
        return false;
    }
    
    printf("✅ Firmware hash calculated (%zu bytes)\n", hash_length);
    print_hex("📝 Firmware SHA-256", firmware_hash, HASH_SIZE);
    
    // Set up private key attributes
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH);
    psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
    psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_bits(&attributes, 256);
    
    // Import the private key
    status = psa_import_key(&attributes, private_key, 32, &key_id);
    if (status != PSA_SUCCESS) {
        printf("❌ Private key import failed: %d\n", (int)status);
        goto cleanup;
    }
    printf("✅ Private key imported (ID: %u)\n", (unsigned)key_id);
    
    // Sign the hash
    status = psa_sign_hash(key_id, PSA_ALG_ECDSA(PSA_ALG_SHA_256),
                          firmware_hash, hash_length,
                          signature, SIGNATURE_SIZE, &signature_length);
    
    if (status != PSA_SUCCESS) {
        printf("❌ Signing failed: %d\n", (int)status);
        goto cleanup;
    }
    
    if (signature_length != SIGNATURE_SIZE) {
        printf("❌ Signature length mismatch: got %zu, expected %d\n", 
               signature_length, SIGNATURE_SIZE);
        goto cleanup;
    }
    
    printf("✅ Firmware signed successfully\n");
    printf("📝 Signature length: %zu bytes\n", signature_length);
    print_hex("🔐 Signature", signature, SIGNATURE_SIZE);
    
    success = true;
    
cleanup:
    if (key_id != 0) {
        psa_destroy_key(key_id);
    }
    psa_reset_key_attributes(&attributes);
    return success;
}

int main(int argc, char* argv[]) {
    printf("=== PSA Firmware Signing Tool ===\n\n");
    
    if (argc != 4) {
        print_usage(argv[0]);
        return 1;
    }
    
    const char* firmware_file = argv[1];
    const char* private_key_file = argv[2];
    const char* output_file = argv[3];
    
    printf("📁 Input firmware: %s\n", firmware_file);
    printf("🔑 Private key: %s\n", private_key_file);
    printf("📄 Output signature: %s\n", output_file);
    printf("\n");
    
    // Read firmware file
    size_t firmware_size;
    uint8_t* firmware_data = read_file(firmware_file, &firmware_size);
    if (!firmware_data) {
        return 1;
    }
    printf("✅ Firmware loaded: %zu bytes\n", firmware_size);
    
    // Read private key file
    size_t key_size;
    uint8_t* private_key = read_file(private_key_file, &key_size);
    if (!private_key) {
        free(firmware_data);
        return 1;
    }
    
    if (key_size != 32) {
        printf("❌ Error: Private key must be exactly 32 bytes, got %zu bytes\n", key_size);
        printf("💡 Hint: Convert PEM to raw format first\n");
        free(firmware_data);
        free(private_key);
        return 1;
    }
    printf("✅ Private key loaded: %zu bytes\n", key_size);
    
    // Sign the firmware
    uint8_t signature[SIGNATURE_SIZE];
    if (!sign_firmware_with_psa(firmware_data, firmware_size, private_key, signature)) {
        printf("❌ Firmware signing failed\n");
        free(firmware_data);
        free(private_key);
        return 1;
    }
    
    // Write signature file
    if (!write_file(output_file, signature, SIGNATURE_SIZE)) {
        printf("❌ Failed to write signature file\n");
        free(firmware_data);
        free(private_key);
        return 1;
    }
    
    printf("✅ Signature written to: %s\n", output_file);
    printf("\n🎉 Firmware signing completed successfully!\n");
    printf("📋 Next steps:\n");
    printf("   1. Upload firmware.bin and signature file for OTA\n");
    printf("   2. ESP32 will verify signature using PSA crypto\n");
    printf("   3. Signature verification should now work correctly\n");
    
    // Cleanup
    free(firmware_data);
    free(private_key);
    
    return 0;
} 