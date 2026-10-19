// Emulator-only support, compiled to nothing unless CHROMABAY_EMU is defined (the *-emu envs in
// platformio.ini). Release builds see an empty translation unit, so their images are unchanged.
//
// esp32sim's virtual BLE controller (--ble) needs a _bt_controller_bss_start/_end symbol pair
// spanning at least 512 bytes of DRAM, as scratch for the controller task it injects. IDF 5
// defines that range; IDF 4.4 (arduino-esp32 2.0.x, which we pin) does not, and esp32sim refuses
// to start without it. This reserves a 1 KB buffer and names it. The constructor keeps the buffer
// from being dropped by --gc-sections. See documentation/ESP32_EMULATOR.md.
#if defined(CHROMABAY_EMU) && CHROMABAY_EMU

__attribute__((used, aligned(16), section(".bss.emu_bt_bss"))) static unsigned char emu_bt_bss[1024];
__asm__(".global _bt_controller_bss_start\n.set _bt_controller_bss_start, emu_bt_bss\n"
        ".global _bt_controller_bss_end\n.set _bt_controller_bss_end, emu_bt_bss + 1024\n");
__attribute__((constructor)) static void emu_bt_keep(void) { __asm__ volatile("" :: "r"(emu_bt_bss)); }

#endif
