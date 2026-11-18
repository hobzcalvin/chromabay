#!/usr/bin/env python3
"""TPS61088 boost: control-loop check (what TI WEBENCH does for this part, from the datasheet's
small-signal model, SLVSCM9 / ZHCSDP8A sec. 9.2.2.7), plus inductor peak current vs limits.

    python3 tools/boost_loop.py

Power stage (peak-current-mode, eq. 13-16):
    Gps(s) = Ro(1-D)/(2 Rsense) * (1 + s/wESR)(1 - s/wRHP) / (1 + s/wP)
    wP = 2/(Ro Co), wESR = 1/(Resr Co), wRHP = Ro(1-D)^2 / L,  Rsense = 0.08 ohm
Compensation (eq. 17): gm amplifier, R5 + C5 from COMP to GND, C8 from COMP to GND
    Gc(s) = GEA REA VREF/VOUT * (1 + s/wZ) / ((1 + s/wP1)(1 + s/wP2))
    wZ = 1/(R5 C5), wP1 = 1/(REA C5), wP2 = 1/(R5 C8)
Added (not in the datasheet model, makes it more conservative): the current-loop sampling double
pole at fsw/2 with Q = 1 (typical with internal slope compensation).
TI targets: crossover <= min(fsw/10, fRHP/5), phase margin > 45 deg, gain margin > 10 dB.
"""
import cmath
import math

VOUT, VREF, GEA, RSENSE = 5.10, 1.204, 190e-6, 0.08
REA = 10e6              # gm amplifier output resistance: not in the datasheet, typical value (only
#                         moves the very-low-frequency pole, not crossover or margins)
L_NOM = 1.0e-6          # MWSA0402S-1R0MT: 1 uH +-20 %, Isat 7 A, Irated 6 A
ESR = 0.002             # 4 MLCCs in parallel
EFF = 0.88

# Output capacitance after DC-bias derating at 5.1 V (X5R/X7R):
#   3 x 22 uF 0805 25 V (C45783): ~11 uF each at 5 V   -> 33 uF
#   1 x 100 uF 1206 6.3 V (C15008): ~30 uF at 5 V
#   1 x 1 uF 0402
CO_CASES = {"derated (realistic)": 33e-6 + 30e-6 + 0.5e-6, "nominal (no derating)": 3 * 22e-6 + 100e-6 + 1e-6,
            "worst low (heavily derated)": 3 * 8e-6 + 22e-6 + 0.4e-6}


def fsw(vin, rfreq=150e3):
    # eq. 2 solved for fsw: 1/fsw = RFREQ*CFREQ/4 + tDELAY*VOUT/VIN
    return 1 / (rfreq * 23e-12 / 4 + 89e-9 * VOUT / vin)


def loop(vin, iout, co, r5, c5, c8, l=L_NOM):
    d = 1 - vin * EFF / VOUT
    ro = VOUT / iout
    f_s = fsw(vin)
    wp, wesr, wrhp = 2 / (ro * co), 1 / (ESR * co), ro * (1 - d) ** 2 / l
    wz, wp1, wp2 = 1 / (r5 * c5), 1 / (REA * c5), 1 / (r5 * c8)
    wn, q = math.pi * f_s, 1.0
    k_ps = ro * (1 - d) / (2 * RSENSE)
    k_c = GEA * REA * VREF / VOUT

    def T(f):
        s = 2j * math.pi * f
        gps = k_ps * (1 + s / wesr) * (1 - s / wrhp) / (1 + s / wp)
        samp = 1 / (1 + s / (wn * q) + (s / wn) ** 2)
        gc = k_c * (1 + s / wz) / ((1 + s / wp1) * (1 + s / wp2))
        return gps * samp * gc

    fs = [10 ** (k / 400) for k in range(400, 400 * 7)]      # 10 Hz .. 10 MHz
    fc = pm = gm = None
    prev = None
    unwrap = 0.0
    last_ph = None
    for f in fs:
        t = T(f)
        mag = abs(t)
        ph = math.degrees(cmath.phase(t))
        if last_ph is not None:
            while ph + unwrap - last_ph > 180:
                unwrap -= 360
            while ph + unwrap - last_ph < -180:
                unwrap += 360
        ph_u = ph + unwrap
        last_ph = ph_u
        if prev and prev[1] >= 1 > mag and fc is None:
            fc, pm = f, 180 + ph_u
        if prev and prev[2] > -180 >= ph_u and gm is None:
            gm = -20 * math.log10(mag)
        prev = (f, mag, ph_u)
    return dict(fsw=f_s, frhp=wrhp / 2 / math.pi, fc=fc, pm=pm, gm=gm, d=d)


def ti_values(vin, iout, co, fc=None):
    """TI's own sizing (eq. 18-20) for the worst case (min VIN, max IOUT)."""
    d = 1 - vin * EFF / VOUT
    ro = VOUT / iout
    frhp = ro * (1 - d) ** 2 / (2 * math.pi * L_NOM)
    fc = fc or min(fsw(vin) / 10, frhp / 5)
    r5 = 2 * math.pi * VOUT * RSENSE * fc * co / ((1 - d) * VREF * GEA)
    c5 = ro * co / (2 * r5)
    c8 = ESR * co / r5
    return fc, r5, c5, c8


def inductor(vin, iout, l=L_NOM * 0.8):
    idc = VOUT * iout / (vin * EFF)
    ipp = 1 / (l * (1 / (VOUT - vin) + 1 / vin) * fsw(vin))
    return idc, ipp, idc + ipp / 2


def main():
    R5, C5, C8 = 15e3, 4.7e-9, 47e-12         # as built: R19 / C16 / C17
    print("TPS61088 boost loop, as built: R5 = 15k, C5 = 4.7 nF, C8 = 47 pF\n")
    print(f"{'Co case':28} {'VIN':>4} {'IOUT':>5} {'fsw':>8} {'fRHP':>8} {'fc':>8} {'PM':>6} {'GM':>6}")
    worst_pm, worst_gm = 999, 999
    for name, co in CO_CASES.items():
        for vin in (3.0, 3.7, 4.2):
            for iout in (0.2, 1.0, 2.0, 3.0):
                r = loop(vin, iout, co, R5, C5, C8)
                worst_pm = min(worst_pm, r["pm"] or 0)
                worst_gm = min(worst_gm, r["gm"] if r["gm"] is not None else 99)
                print(f"{name:28} {vin:4.1f} {iout:5.1f} {r['fsw']/1e3:7.0f}k {r['frhp']/1e3:7.0f}k "
                      f"{(r['fc'] or 0)/1e3:7.1f}k {r['pm'] or 0:6.1f} {r['gm'] if r['gm'] is not None else 99:6.1f}")
    print(f"\nworst-case phase margin {worst_pm:.1f} deg (TI: > 45), gain margin {worst_gm:.1f} dB (TI: > 10)")
    co = CO_CASES["derated (realistic)"]
    fc, r5, c5, c8 = ti_values(3.0, 3.0, co)
    print(f"\nTI eq. 18-20 at VIN 3.0 V, IOUT 3 A, Co {co*1e6:.0f} uF: fc {fc/1e3:.1f} kHz -> "
          f"R5 {r5/1e3:.1f}k, C5 {c5*1e9:.1f} nF, C8 {c8*1e12:.1f} pF")
    print("\nInductor (L -20 %, eff 88 %):")
    for vin, iout in ((3.0, 2.0), (3.0, 3.0), (3.3, 3.0), (3.7, 3.0)):
        idc, ipp, pk = inductor(vin, iout)
        print(f"  VIN {vin:.1f} V, IOUT {iout:.1f} A: IDC {idc:.2f} A, ripple {ipp:.2f} A p-p, peak {pk:.2f} A")
    for r in (150e3, 180e3, 200e3):
        print(f"  ILIM with RILIM {r/1e3:.0f}k: {1.19e6/r:.2f} A typ ({1.06e6/r:.2f}-{1.30e6/r:.2f} A)  vs inductor Isat 7 A")


if __name__ == "__main__":
    main()
