"""Single source of truth for the ChromaBay controller board (rev A).

Every part: reference, symbol, value, footprint, LCSC code (None = not assembled / no part),
and a pin -> net map. gen_sch.py and gen_pcb.py both read this file, so the schematic and the
board can never disagree about connectivity.

Pin keys are the symbol's pin *numbers*. Nets starting with "NC" are no-connects.
"""

# Footprint library nicknames: "lcsc" = easyeda2kicad downloads (lib/lcsc.pretty, exact JLC parts),
# "cb" = hand-made footprints for this board (lib/cb.pretty), others = stock KiCad libraries.
R0402, C0402, C0603, C0805 = "lcsc:R0402", "lcsc:C0402", "lcsc:C0603", "lcsc:C0805"
C1206 = "lcsc:C1206"

# LCSC codes for passives (all JLC Basic or Preferred-Extended = no extended-part fee).
RES = {  # value -> LCSC
    "0R": "C17168", "33R": "C25105", "200R": "C25087", "680R": "C25130", "1k": "C11702",
    "1.5k": "C25867", "4.7k": "C25900", "5.1k": "C25905", "10k": "C25744", "33k": "C25779",
    "68k": "C36871", "24k": "C25769", "100k": "C25741", "150k": "C25755", "220k": "C25767", "22k": "C25768",
}
CAP = {  # (value, size) -> LCSC
    ("100nF", "0402"): "C1525", ("1uF", "0402"): "C52923", ("2.2uF", "0402"): "C12530",
    ("22nF", "0402"): "C1532", ("10nF", "0402"): "C15195", ("4.7nF", "0402"): "C1538", ("47pF", "0402"): "C1567",
    ("1uF", "0603"): "C15849", ("4.7uF", "0603"): "C19666", ("10uF", "0603"): "C19702",
    ("10uF", "0805"): "C15850", ("22uF", "0805"): "C45783", ("100uF", "1206"): "C15008",
}

parts = []
_counters = {}


def _next(prefix):
    _counters[prefix] = _counters.get(prefix, 0) + 1
    return f"{prefix}{_counters[prefix]}"


def part(ref, symbol, value, footprint, lcsc, pins, block, dnp=False, note=""):
    parts.append(dict(ref=ref, symbol=symbol, value=value, footprint=footprint, lcsc=lcsc,
                      pins={str(k): v for k, v in pins.items()}, block=block, dnp=dnp, note=note))


def R(value, a, b, block, note=""):
    part(_next("R"), "Device:R", value, R0402, RES[value], {1: a, 2: b}, block, note=note)


def C(value, a, b, block, size="0402", note=""):
    fp = {"0402": C0402, "0603": C0603, "0805": C0805, "1206": C1206}[size]
    part(_next("C"), "Device:C", value, fp, CAP[(value, size)], {1: a, 2: b}, block, note=note)


def TP(name, net, block):
    """A small solder pad for a wire (spare GPIO, ext mic, I2C, ext switch, UART)."""
    part(_next("TP"), "Connector:TestPoint", name, "TestPoint:TestPoint_Pad_D1.0mm", None,
         {1: net}, block)


# ---------------------------------------------------------------- USB-C input
part("J1", "lcsc:TYPE-C-31-M-12", "USB-C", "lcsc:USB-C_SMD-TYPE-C-31-M-12_1", "C165948", {
    "A1B12": "GND", "B1A12": "GND", "A4B9": "VBUS", "B4A9": "VBUS",
    "A5": "CC1", "B5": "CC2", "A6": "USB_DP", "B6": "USB_DP", "A7": "USB_DM", "B7": "USB_DM",
    "A8": "NC_SBU1", "B8": "NC_SBU2", "1": "GND", "2": "GND", "3": "GND", "4": "GND"}, "usb")
R("5.1k", "CC1", "GND", "usb", "UFP (sink) pulldown")
R("5.1k", "CC2", "GND", "usb", "UFP (sink) pulldown")
R("10k", "CC1", "CC1_SENSE", "usb", "ADC: source capability")
R("10k", "CC2", "CC2_SENSE", "usb", "ADC: source capability")
# SRV05-4 (JLC Preferred-Extended = no loading fee) protects D+/D- and both CC lines, clamped to VBUS.
SRV = ("lcsc:SRV05-4-P-T7", "SRV05-4", "lcsc:SOT-23-6_L2.9-W1.6-P0.95-LS2.8-BR", "C85364")
part("U8", *SRV, {1: "USB_DP", 3: "USB_DM", 4: "CC1", 6: "CC2", 2: "GND", 5: "VBUS"}, "usb")

# ---------------------------------------------------------------- Charger (BQ25606, NVDC)
part("U2", "lcsc:BQ25606RGER", "BQ25606", "lcsc:VQFN-24_L4.0-W4.0-P0.50-TL-EP2.8", "C374063", {
    1: "VBUS", 2: "NC_U2_2", 3: "NC_CHG_DP", 4: "NC_CHG_DM", 5: "CHG_STAT", 6: "GND",
    7: "CHG_PG", 8: "CHG_ILIM", 9: "GND", 10: "CHG_ICHG", 11: "CHG_TS", 12: "NC_VSET",
    13: "BAT", 14: "BAT", 15: "VSYS", 16: "VSYS", 17: "GND", 18: "GND", 19: "CHG_SW",
    20: "CHG_SW", 21: "CHG_BTST", 22: "CHG_REGN", 23: "CHG_PMID", 24: "VBUS", 25: "GND"},
    "charger", note="D+/D- floating -> 'unknown adapter' -> ILIM pin sets input limit. "
                    "VSET floating -> 4.208 V. OTG off, CE tied low (always charge).")
C("1uF", "VBUS", "GND", "charger", "0603")
C("10uF", "CHG_PMID", "GND", "charger", "0805")
C("4.7uF", "CHG_REGN", "GND", "charger", "0603")
C("100nF", "CHG_BTST", "CHG_SW", "charger", note="bootstrap (datasheet 47 nF; 100 nF basic)")
part("L1", "Device:L", "1uH 7A (MWSA0402S)", "lcsc:IND-SMD_L4.4-W4.2", "C408332",
     {1: "CHG_SW", 2: "VSYS"}, "charger")
C("22uF", "VSYS", "GND", "charger", "0805")
C("22uF", "VSYS", "GND", "charger", "0805")
C("10uF", "BAT", "GND", "charger", "0805")
R("200R", "CHG_ILIM", "GND", "charger", "input limit 478/200 = 2.4 A")
# Charge current: ICHG = 677 / R. Base 1.5k = 0.45 A. JP1 adds 1.5k (0.9 A), JP2 adds 680R
# (1.45 A), both = 1.9 A. Solder jumpers ship OPEN, so the default is the safe 0.45 A.
R("1.5k", "CHG_ICHG", "GND", "charger", "ICHG base: 0.45 A")
R("1.5k", "ICHG_J1", "GND", "charger", "ICHG +0.45 A via JP1")
R("680R", "ICHG_J2", "GND", "charger", "ICHG +1.0 A via JP2")
part("JP1", "Jumper:SolderJumper_2_Open", "CHG+0.45A", "Jumper:SolderJumper-2_P1.3mm_Open_RoundedPad1.0x1.5mm",
     None, {1: "CHG_ICHG", 2: "ICHG_J1"}, "charger")
part("JP2", "Jumper:SolderJumper_2_Open", "CHG+1.0A", "Jumper:SolderJumper-2_P1.3mm_Open_RoundedPad1.0x1.5mm",
     None, {1: "CHG_ICHG", 2: "ICHG_J2"}, "charger")
# Thermistor: REGN - 5.1k - TS - 33k - GND, NTC from TS to GND (onboard or pack's own via JP3).
R("5.1k", "CHG_REGN", "CHG_TS", "charger", "TS divider (103AT-class NTC)")
R("24k", "CHG_TS", "GND", "charger", "TS divider: with 5.1k + NCP15XH103 -> charge window ~0.7..61 C")
part("JP3", "Jumper:SolderJumper_3_Bridged12", "NTC SEL", "Jumper:SolderJumper-3_P1.3mm_Bridged12_RoundedPad1.0x1.5mm",
     None, {1: "NTC_ONBOARD", 2: "CHG_TS", 3: "NTC_EXT"}, "charger")
part("TH1", "Device:Thermistor_NTC", "10k NTC", "lcsc:R0402", "C77131",
     {1: "NTC_ONBOARD", 2: "GND"}, "charger", note="sits on the battery side of the board")
R("10k", "CHG_PG", "3V3", "charger", "PG pull-up")

# ---------------------------------------------------------------- Battery input
part("J3", "Connector_Generic:Conn_01x03", "BATTERY", "cb:BatteryPadsSmall", None,
     {1: "BAT_IN", 2: "GND", 3: "NTC_EXT"}, "battery",
     note="wire pads for packs without a plug, + NTC pad")
part("J4", "Connector_Generic_MountingPin:Conn_01x02_MountingPin", "JST-PH 2P",
     "lcsc:CONN-SMD_P2.00_S2B-PH-SM4-TB-LF-SN", "C54582899", {1: "GND", 2: "BAT_IN", "MP": "GND"}, "battery",
     note="swappable battery. CHECK POLARITY against your pack: silk shows + and -")
# Reverse-polarity protection: P-FET, drain to the connector, source to the charger, gate to GND.
part("Q1", "lcsc:AONR21321", "AONR21321", "lcsc:DFN-8_L3.0-W3.0-P0.65-BL", "C541711",
     {1: "BAT", 2: "BAT", 3: "BAT", 4: "Q1_G", 5: "BAT_IN", 6: "BAT_IN", 7: "BAT_IN", 8: "BAT_IN",
      9: "BAT_IN"}, "battery", note="reverse-polarity protection")
R("10k", "Q1_G", "GND", "battery")

# ---------------------------------------------------------------- Fuel gauge
part("U4", "lcsc:MAX17048G+T10", "MAX17048", "lcsc:TDFN-8_L2.0-W2.0-P0.50-BL-EP1.2", "C2682616", {
    1: "GND", 2: "BAT", 3: "BAT", 4: "GND", 5: "GAUGE_ALRT", 6: "GND", 7: "SCL", 8: "SDA",
    9: "GND"}, "gauge")
C("1uF", "BAT", "GND", "gauge")
R("10k", "GAUGE_ALRT", "3V3", "gauge")

# ---------------------------------------------------------------- Power switch + 3.3 V
part("SW1", "lcsc:MSK12C02", "POWER", "lcsc:SW-TH_MSK12C02", "C431540",
     {1: "LDO_EN_SW", 2: "VSYS", 3: "NC_SW1_3", 4: "NC_SW1_MNT"}, "power")
part("JP4", "Jumper:SolderJumper_2_Bridged", "SW", "Jumper:SolderJumper-2_P1.3mm_Bridged_RoundedPad1.0x1.5mm",
     None, {1: "LDO_EN_SW", 2: "LDO_EN"}, "power", note="cut to use an external switch on TP pads")
TP("EXTSW_A", "VSYS", "power")
TP("EXTSW_B", "LDO_EN", "power")
R("100k", "LDO_EN", "GND", "power")
part("U6", "lcsc:TLV75733PDBVR", "TLV75733", "lcsc:SOT-23-5_L2.9-W1.6-P0.95-LS2.8-BL", "C485517",
     {1: "VSYS", 2: "GND", 3: "LDO_EN", 4: "NC_U6_4", 5: "3V3"}, "power")
C("1uF", "VSYS", "GND", "power")
C("1uF", "3V3", "GND", "power")

# ---------------------------------------------------------------- 5 V boost (TPS61088)
part("U3", "lcsc:TPS61088RHLR", "TPS61088", "lcsc:VQFN-20_L4.6-W3.6-P0.50-BL", "C87357", {
    1: "BST_VCC", 2: "LED_EN", 3: "BST_FSW", 4: "BST_SW", 5: "BST_SW", 6: "BST_SW", 7: "BST_SW",
    8: "BST_BOOT", 9: "VSYS", 10: "BST_SS", 11: "NC_U3_11", 12: "NC_U3_12", 13: "NC_BST_MODE",
    14: "5V_BOOST", 15: "5V_BOOST", 16: "5V_BOOST", 17: "BST_FB", 18: "BST_COMP",
    19: "BST_ILIM", 20: "GND", 21: "GND"}, "boost",
    note="MODE floating = PFM at light load. Compensation values to be confirmed in WEBENCH.")
part("L2", "Device:L", "1uH 7A (MWSA0402S)", "lcsc:IND-SMD_L4.4-W4.2", "C408332",
     {1: "VSYS", 2: "BST_SW"}, "boost")
C("10uF", "VSYS", "GND", "boost", "0805")
C("100nF", "VSYS", "GND", "boost")
C("2.2uF", "BST_VCC", "GND", "boost")
C("100nF", "BST_BOOT", "BST_SW", "boost")
R("150k", "BST_FSW", "BST_SW", "boost", "RFREQ: ~1 MHz")
C("22nF", "BST_SS", "GND", "boost", note="soft start ~5 ms")
R("220k", "5V_BOOST", "BST_FB", "boost", "Vout = 1.204*(1+220/68) = 5.10 V")
R("68k", "BST_FB", "GND", "boost")
R("10k", "BST_COMP", "BST_COMP_RC", "boost", "R5 = pi*Vout*Rsense*fc*Co/((1-D)*Vref*Gea), fc=15kHz, Co~75uF eff -> 10.7k")
C("10nF", "BST_COMP_RC", "GND", "boost", note="C5 = Ro*Co/(2*R5) -> 6.4..9.6 nF")
C("47pF", "BST_COMP", "GND", "boost", note="C8 = Resr*Co/R5 ~ 40 pF")
R("150k", "BST_ILIM", "GND", "boost", "peak switch limit 1.19e6/150k = 7.9 A")
for _ in range(3):
    C("22uF", "5V_BOOST", "GND", "boost", "0805")
C("1uF", "5V_BOOST", "GND", "boost")
C("100uF", "5V_BOOST", "GND", "boost", "1206")
R("100k", "LED_EN", "GND", "boost", "LED rail off unless firmware drives it")

# ---------------------------------------------------------------- LED load switch + output protection
part("Q2", "lcsc:AONR21321", "AONR21321", "lcsc:DFN-8_L3.0-W3.0-P0.65-BL", "C541711",
     {1: "5V_BOOST", 2: "5V_BOOST", 3: "5V_BOOST", 4: "LS_G", 5: "VLED_SW", 6: "VLED_SW",
      7: "VLED_SW", 8: "VLED_SW", 9: "VLED_SW"}, "loadsw", note="high-side LED power switch")
R("100k", "LS_G", "5V_BOOST", "loadsw", "gate pull-up = off")
C("100nF", "LS_G", "5V_BOOST", "loadsw", note="soft start with the 10k")
R("10k", "LS_G", "LS_D", "loadsw")
part("Q3", "lcsc:2N7002", "2N7002", "lcsc:SOT-23-3_L2.9-W1.3-P1.90-LS2.4-BR", "C8545",
     {1: "LED_EN", 2: "GND", 3: "LS_D"}, "loadsw")
part("F1", "lcsc:SMD1812P300TF", "3A PTC", "lcsc:F1812", "C21004",
     {1: "VLED_SW", 2: "VLED_F"}, "loadsw")
part("JP5", "Jumper:SolderJumper_2_Bridged", "EXT", "Jumper:SolderJumper-2_P1.3mm_Bridged_RoundedPad1.0x1.5mm",
     None, {1: "VLED_F", 2: "VLED"}, "loadsw", note="cut for an external LED supply")
C("10uF", "VLED", "GND", "loadsw", "0805")

# ---------------------------------------------------------------- Level shifter + outputs
OUT = ["C1", "D1", "C2", "D2", "C3", "D3", "C4", "D4"]
part("U7", "lcsc:74AHCT245PW", "74AHCT245", "lcsc:TSSOP-20_L6.5-W4.4-P0.65-LS6.4-BL", "C54815895", {
    1: "5V_BOOST", **{2 + i: f"LS_{n}" for i, n in enumerate(OUT)}, 10: "GND",
    **{18 - i: f"BUF_{n}" for i, n in enumerate(OUT)}, 19: "SHIFT_OE", 20: "5V_BOOST"}, "shifter",
    note="DIR high = A->B. /OE pulled up: outputs off until firmware enables them.")
C("100nF", "5V_BOOST", "GND", "shifter")
R("10k", "SHIFT_OE", "3V3", "shifter")
for n in OUT:
    R("33R", f"BUF_{n}", f"OUT_{n}", "shifter")
part("U9", *SRV, {1: "OUT_C1", 3: "OUT_D1", 4: "OUT_C2", 6: "OUT_D2", 2: "GND", 5: "5V_BOOST"},
     "shifter", note="output ESD")
part("U10", *SRV, {1: "OUT_C3", 3: "OUT_D3", 4: "OUT_C4", 6: "OUT_D4", 2: "GND", 5: "5V_BOOST"},
     "shifter", note="output ESD")
# OUT1 solder-free: two WAGO 2060 push-in blocks (SMD, reflowed by JLC, 4.5 mm tall, 18-24 AWG,
# wire entry facing the right wall). Every output, OUT1 included, is also on the J5 solder pads.
WAGO = ("Connector_Generic:Conn_01x02", "lcsc:CONN-SMD_2060-452", "C2765055")
part("J2", WAGO[0], "OUT1 power (G V)", WAGO[1], WAGO[2], {1: "GND", 2: "VLED"}, "shifter",
     note="WAGO 2060-452/998-404 push-in")
part("J6", WAGO[0], "OUT1 data (C1 D1)", WAGO[1], WAGO[2], {1: "OUT_C1", 2: "OUT_D1"}, "shifter",
     note="WAGO 2060-452/998-404 push-in")
part("J5", "Connector_Generic:Conn_01x10", "LED OUT pads", "cb:OutputPads", None,
     {1: "GND", 2: "VLED", **{3 + i: f"OUT_{n}" for i, n in enumerate(OUT)}}, "shifter",
     note="all 8 LED lines + G/V as 2.54 mm wire pads")

# ---------------------------------------------------------------- ESP32-S3
GPIO = {  # module pin number -> net
    4: "BOOT", 5: "CC1_SENSE", 6: "CC2_SENSE", 7: "IO3", 8: "T1", 9: "T2", 10: "T3", 11: "T4",
    12: "SDA", 13: "SCL", 14: "IMU_INT1", 15: "IO11", 16: "CHG_PG", 17: "IMU_INT2",
    18: "GAUGE_ALRT", 19: "LS_C1", 20: "LS_D1", 21: "LS_C2", 22: "LS_D2", 23: "USB_DM",
    24: "USB_DP", 25: "LS_C3", 26: "IO26", 27: "EXT_WS", 28: "LS_D3", 29: "LS_C4",
    30: "EXT_SD", 31: "LS_D4", 32: "SHIFT_OE", 33: "LED_EN", 34: "PDM_CLK", 35: "PDM_DATA",
    36: "EXT_BCLK", 37: "STATUS_LED", 38: "USER_BTN", 39: "IO43", 40: "IO44", 41: "IO45",
    44: "IO46", 45: "ESP_EN", 3: "3V3"}
for gnd in [1, 2, 42, 43] + list(range(46, 61)) + ["GND"]:
    GPIO[gnd] = "GND"
part("U1", "lcsc:ESP32-S3-MINI-1-N8", "ESP32-S3-MINI-1-N8", "lcsc:BULETM-SMD_ESP32-S3-MINI-1-N8",
     "C2913206", GPIO, "mcu", note="IO47/IO48 are 3.3 V on the N8 (no PSRAM, 3.3 V flash)")
C("10uF", "3V3", "GND", "mcu", "0603")
C("100nF", "3V3", "GND", "mcu")
R("10k", "ESP_EN", "3V3", "mcu")
C("1uF", "ESP_EN", "GND", "mcu", note="EN delay")
# BOOT is a user pad (GPIO0; touch it to GND while switching on = download mode). No RESET: the
# power switch is the reset. GPIO0 and the user button use the S3's internal pull-ups.
part("SW2", "lcsc:K2-1114SA-A4SW-06", "USER", "lcsc:KEY-SMD_4P-L4.8-W4.6-P1.70-LS6.2", "C136662",
     {1: "USER_BTN", 2: "USER_BTN", 3: "GND", 4: "GND"}, "mcu", note="side-actuated, business end")
# (No UART pads: the S3's native USB serial/JTAG covers logging and recovery. TXD0/RXD0 left unconnected.)

# ---------------------------------------------------------------- Indicators
# (Dark builds: the status LED is firmware-controlled; the charge LED can be disabled by
#  removing its 1k resistor.)
part("D1", "lcsc:LTST-S326KGJRKT", "CHG/STATUS", "lcsc:LED-SMD_LTST-S326KGJRKT", "C125116",
     {3: "VSYS", 1: "LED_K_CHG", 2: "LED_K_STAT"}, "leds", note="side-view bicolor, common anode")
R("1k", "LED_K_CHG", "CHG_STAT", "leds", "charge LED, hardware-driven (works with switch off)")
R("1k", "LED_K_STAT", "STAT_D", "leds")
part("Q4", "lcsc:2N7002", "2N7002", "lcsc:SOT-23-3_L2.9-W1.3-P1.90-LS2.4-BR", "C8545",
     {1: "STATUS_LED", 2: "GND", 3: "STAT_D"}, "leds")
R("100k", "STATUS_LED", "GND", "leds")

# ---------------------------------------------------------------- Sensors
part("U5", "lcsc:LSM6DS3TR-C", "LSM6DS3TR-C", "lcsc:LGA-14_L3.0-W2.5-P0.50-TL", "C967633", {
    1: "GND", 2: "GND", 3: "GND", 4: "IMU_INT1", 5: "3V3", 6: "GND", 7: "GND", 8: "3V3",
    9: "IMU_INT2", 10: "NC_U5_10", 11: "NC_U5_11", 12: "3V3", 13: "SCL", 14: "SDA"}, "sensors",
    note="I2C addr 0x6A (SA0 low)")
C("100nF", "3V3", "GND", "sensors")
C("100nF", "3V3", "GND", "sensors")
R("4.7k", "SDA", "3V3", "sensors")
R("4.7k", "SCL", "3V3", "sensors")
part("MK1", "lcsc:GMA3526H10-B26", "PDM MIC", "lcsc:MIC-SMD_GMA3526H10-B26", "C498192",
     {1: "PDM_DATA", 2: "GND", 3: "GND", 4: "PDM_CLK", 5: "MIC_VDD"}, "sensors",
     note="bottom port; SELECT low = left channel")
part("JP7", "Jumper:SolderJumper_2_Bridged", "MIC", "Jumper:SolderJumper-2_P1.3mm_Bridged_RoundedPad1.0x1.5mm",
     None, {1: "3V3", 2: "MIC_VDD"}, "sensors", note="cut to disable the onboard mic")
C("1uF", "MIC_VDD", "GND", "sensors")
C("100nF", "MIC_VDD", "GND", "sensors")

# ---------------------------------------------------------------- User pads
# Every otherwise-unused GPIO gets a pad. IO3/IO45/IO46 are strapping pins: don't pull IO45 or
# IO46 high at boot. IO43/IO44 are UART0 TX/RX (boot log).
for name, net in [("IO3", "IO3"), ("IO11", "IO11"), ("IO26", "IO26"), ("IO43", "IO43"), ("IO44", "IO44"),
                  ("IO45", "IO45"), ("IO46", "IO46"), ("3V3", "3V3"), ("GND", "GND"), ("SDA", "SDA"), ("SCL", "SCL"),
                  ("T1", "T1"), ("T2", "T2"), ("T3", "T3"), ("T4", "T4"), ("BOOT", "BOOT"),
                  ("MIC_BCLK", "EXT_BCLK"), ("MIC_WS", "EXT_WS"), ("MIC_SD", "EXT_SD")]:
    TP(name, net, "pads")

# No mounting holes: the case clamps the board edges, and holes cost ~50 mm2 here.


def nets():
    out = {}
    for p in parts:
        for pin, net in p["pins"].items():
            if not net.startswith("NC"):
                out.setdefault(net, []).append((p["ref"], pin))
    return out


if __name__ == "__main__":
    n = nets()
    print(len(parts), "parts,", len(n), "nets")
    for net, conns in sorted(n.items()):
        if len(conns) < 2:
            print("  single-pin net:", net, conns)
