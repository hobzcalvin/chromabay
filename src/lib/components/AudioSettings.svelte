<script lang="ts">
  // The device's microphone. Everything applies as you change it (no Save): sliders and
  // buttons send small patches to AUDIO_CONFIG, and the device saves them to flash once you
  // stop. The live meter polls the device so you can tune by ear. Names are plain-language;
  // WLED's names for the same settings are in small print, since a converted WLED device
  // brings them over 1:1.
  import {
    readAudioStatus, writeAudioSettings, MIC_TYPES, MIC_PDM, MIC_MCLK, MIC_SIMULATED, AGC_MODES, FREQ_SCALES,
    type AudioStatus, type AudioSettingsPatch,
  } from '$lib/ble';

  let { deviceId, chip }: { deviceId: string; chip?: string } = $props();

  let status = $state<AudioStatus | null>(null);
  let loaded = $state(false);
  let note = $state('');
  let noteErr = $state(false);

  // Form
  let en = $state(false);
  let type = $state(1);
  let sd = $state(-1), ws = $state(-1), sck = $state(-1), mclk = $state(-1);
  let sq = $state(10), gain = $state(60), agc = $state(0);
  let lim = $state(true), rise = $state(80), fall = $state(1400), scale = $state(3);

  const isPdm = $derived(type === MIC_PDM);
  const isSim = $derived(type === MIC_SIMULATED);
  const typeInfo = $derived(MIC_TYPES.find((t) => t.value === type));

  // GPIOs a mic can use on this chip: the ones that exist, minus the flash bus (using one of
  // those crashes the board; the firmware refuses them too). On the classic ESP32, 34-39 are
  // inputs only: fine for the mic's data (SD), not for the clocks the ESP32 drives.
  const GPIOS: Record<string, number[]> = {
    esp32: [...Array(40).keys()].filter((g) => ![6, 7, 8, 9, 10, 11, 20, 24, 28, 29, 30, 31].includes(g)),
    esp32s3: [...Array(49).keys()].filter((g) => g <= 21 || g >= 33),
    esp32c3: [...Array(22).keys()].filter((g) => g < 12 || g > 17),
  };
  const gpios = $derived(GPIOS[chip ?? ''] ?? GPIOS.esp32);
  const inputOnly = (g: number) => (chip ?? 'esp32') === 'esp32' && g >= 34;

  function apply(s: AudioStatus) {
    en = s.en === 1; type = s.type;
    sd = s.sd; ws = s.ws; sck = s.sck; mclk = s.mclk;
    sq = s.sq; gain = s.gain; agc = s.agc;
    lim = s.lim === 1; rise = s.rise; fall = s.fall; scale = s.scale;
  }

  // ---- reading: the first read fills the form; later ones only refresh the live view ----
  $effect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stop) return;
      const s = await readAudioStatus(deviceId).catch(() => null);
      if (s && !stop) status = s;
      timer = setTimeout(poll, 300);
    };
    readAudioStatus(deviceId).then((s) => {
      if (stop) return;
      status = s;
      if (s) apply(s);
      loaded = true;
      timer = setTimeout(poll, 300);
    });
    return () => { stop = true; clearTimeout(timer); };
  });

  // ---- writing: coalesce changes, at most one write in flight, ~8 per second while dragging ----
  let pending: AudioSettingsPatch = {};
  let sending = false;
  let lastSent = 0;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  function send(patch: AudioSettingsPatch) {
    pending = { ...pending, ...patch };
    void pump();
  }
  async function pump() {
    if (sending || Object.keys(pending).length === 0) return;
    sending = true;
    const wait = 120 - (Date.now() - lastSent);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const p = pending;
    pending = {};
    try {
      await writeAudioSettings(deviceId, p);
      note = 'Saved'; noteErr = false;
    } catch (e: any) {
      note = 'Couldn’t reach the device: ' + (e?.message ?? e); noteErr = true;
    }
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { if (!noteErr) note = ''; }, 1500);
    lastSent = Date.now();
    sending = false;
    void pump();
  }

  // ---- "set from silence": measure the room's quiet level, put the noise floor just above ----
  let measuring = $state(0); // seconds left
  async function measureSilence() {
    if (measuring) return;
    let peak = 0;
    const end = Date.now() + 3000;
    measuring = 3;
    while (Date.now() < end) {
      const s = await readAudioStatus(deviceId).catch(() => null);
      if (s?.lvl != null) peak = Math.max(peak, s.lvl);
      measuring = Math.max(1, Math.ceil((end - Date.now()) / 1000));
      await new Promise((r) => setTimeout(r, 120));
    }
    measuring = 0;
    sq = Math.max(0, Math.min(255, Math.round(peak * 1.25 + 2)));
    send({ sq });
  }

  // ---- display helpers ----
  const SCALE_MAX = 255; // the meter's full scale, in Squelch units
  // A square-root scale: room noise (single digits) and loud music (100+) both stay visible.
  const meterPos = (v: number | undefined) => `${Math.round(Math.sqrt(Math.max(0, Math.min(SCALE_MAX, v ?? 0)) / SCALE_MAX) * 1000) / 10}%`;
  const pct = (v: number | undefined) => `${Math.round(Math.max(0, Math.min(1, v ?? 0)) * 100)}%`;
  const AGC_HELP = ['you set the sensitivity', 'adjusts in a few seconds', 'adjusts fast, punchier', 'adjusts slowly, steadier'];
  const SCALE_SHORT: Record<number, string> = { 0: 'None', 2: 'Linear', 3: 'Square root', 1: 'Log' };
</script>

<div class="audio">
  {#if !loaded}
    <p class="hint">Reading audio settings…</p>
  {:else if !status}
    <p class="hint">This device's firmware doesn't support audio input.</p>
  {:else}
    <label class="switch">
      <input type="checkbox" checked={en} onchange={(e) => { en = e.currentTarget.checked; send({ en: en ? 1 : 0 }); }} />
      <span>Listen to a microphone</span>
    </label>

    {#if en}
      <label class="field">
        <span class="lbl">Microphone</span>
        <select value={type} onchange={(e) => { type = +e.currentTarget.value; send({ type }); }}>
          {#each MIC_TYPES as t (t.value)}
            <option value={t.value} disabled={!t.supported && t.value !== type}>{t.label}</option>
          {/each}
        </select>
      </label>
      {#if typeInfo && !typeInfo.supported}
        <p class="hint warn">ChromaBay can't drive this microphone yet. Generic I2S mics (INMP441, ICS-43434), SPH0645 and PDM mics work.</p>
      {:else if isPdm && status.pdm === 0}
        <p class="hint warn">This chip can't record a PDM microphone. Use an I2S mic, or an ESP32 / ESP32-S3 board.</p>
      {/if}

      {#if !isSim}
        {#snippet pinPick(label: string, sub: string, value: number, set: (v: number) => void, out: boolean)}
          <label class="pin">
            <span class="lbl">{label} <i>{sub}</i></span>
            <select {value} onchange={(e) => set(+e.currentTarget.value)}>
              <option value={-1}>—</option>
              {#each gpios as g}<option value={g} disabled={out && inputOnly(g)}>GPIO {g}</option>{/each}
            </select>
          </label>
        {/snippet}
        <div class="pins">
          {@render pinPick('Data', 'SD', sd, (v) => { sd = v; send({ sd: v }); }, false)}
          {@render pinPick(isPdm ? 'Clock' : 'Word select', isPdm ? 'CLK / WS' : 'WS / LRCK', ws, (v) => { ws = v; send({ ws: v }); }, true)}
          {#if !isPdm}
            {@render pinPick('Bit clock', 'SCK / BCLK', sck, (v) => { sck = v; send({ sck: v }); }, true)}
          {/if}
          {#if type === MIC_MCLK}
            {@render pinPick('Master clock', 'MCLK', mclk, (v) => { mclk = v; send({ mclk: v }); }, true)}
          {/if}
        </div>
      {/if}

      <!-- Live view -->
      <div class="live">
        <p class="status" class:warn={status.run === 0 || /^no signal/.test(status.status)}>
          {status.status}{status.run && status.bpm > 0 ? ` · ${status.bpm.toFixed(0)} bpm` : ''}
        </p>
        <div class="meter" title="Input level. The white mark is the noise floor: anything left of it counts as silence.">
          <span>Input</span>
          <div class="bar level"><div style:width={meterPos(status.lvl)}></div><b style:left={meterPos(sq)}></b></div>
        </div>
        <div class="meter"><span>Volume</span><div class="bar"><div style:width={pct(status.vol)}></div></div></div>
        <div class="meter"><span>Beat</span><div class="bar beat"><div style:width={pct(status.beat)}></div></div></div>
        <div class="spectrum" aria-label="Frequency bands, low to high">
          {#each status.bands ?? [] as b}<div class="col"><div style:height={`${Math.max(2, b)}%`}></div></div>{/each}
        </div>
      </div>

      <!-- Tuning: applies live -->
      <div class="slider">
        <div class="row"><span class="lbl">Sensitivity <i>Gain</i></span><b>{(gain / 40).toFixed(1)}×</b></div>
        <input type="range" min="1" max="255" step="1" value={gain}
          oninput={(e) => { gain = +e.currentTarget.value; send({ gain }); }} />
        <p class="help">How much to amplify the mic. Turn it up until loud music fills the Volume bar.</p>
      </div>

      <div class="slider">
        <div class="row"><span class="lbl">Noise floor <i>Squelch</i></span><b>{sq}</b></div>
        <input type="range" min="0" max={Math.max(100, sq)} step="1" value={sq}
          oninput={(e) => { sq = +e.currentTarget.value; send({ sq }); }} />
        <p class="help">Sounds quieter than this count as silence (the white mark on Input). Set it just above the room's quiet hum.</p>
        <button type="button" class="btn small" disabled={!!measuring || status.run === 0} onclick={measureSilence}>
          {measuring ? `Stay quiet… ${measuring}` : 'Set from 3 s of silence'}
        </button>
      </div>

      <div class="field">
        <div class="row"><span class="lbl">Auto level <i>AGC</i></span></div>
        <div class="seg" role="group" aria-label="Auto level">
          {#each AGC_MODES as m, i}
            <button type="button" class:on={agc === i} aria-pressed={agc === i} onclick={() => { agc = i; send({ agc }); }}>{m}</button>
          {/each}
        </div>
        <p class="help">Off: {AGC_HELP[0]}. On, it follows the room getting louder or quieter. Normal {AGC_HELP[1]}; Vivid {AGC_HELP[2]}; Lazy {AGC_HELP[3]}.</p>
      </div>

      <details class="advanced">
        <summary>Advanced</summary>
        <label class="switch">
          <input type="checkbox" checked={lim} onchange={(e) => { lim = e.currentTarget.checked; send({ lim: lim ? 1 : 0 }); }} />
          <span>Smooth the volume <i>Limiter</i></span>
        </label>
        {#if lim}
          <div class="slider">
            <div class="row"><span class="lbl">Rise <i>attack</i></span><b>{rise} ms</b></div>
            <input type="range" min="0" max="500" step="10" value={rise}
              oninput={(e) => { rise = +e.currentTarget.value; send({ rise }); }} />
            <p class="help">How quickly the volume jumps up when it gets louder. Lower is snappier.</p>
          </div>
          <div class="slider">
            <div class="row"><span class="lbl">Fall <i>release</i></span><b>{(fall / 1000).toFixed(2)} s</b></div>
            <input type="range" min="0" max="5000" step="50" value={fall}
              oninput={(e) => { fall = +e.currentTarget.value; send({ fall }); }} />
            <p class="help">How slowly it falls back when it gets quieter. Higher glows longer after each hit.</p>
          </div>
        {/if}
        <div class="field">
          <div class="row"><span class="lbl">Band response <i>Frequency scale</i></span></div>
          <div class="seg" role="group" aria-label="Band response">
            {#each FREQ_SCALES as f (f.value)}
              <button type="button" class:on={scale === f.value} aria-pressed={scale === f.value} onclick={() => { scale = f.value; send({ scale }); }}>{SCALE_SHORT[f.value]}</button>
            {/each}
          </div>
          <p class="help">How the spectrum bars react. Square root (the default) suits most music; Log lifts quiet bands; Linear and None are the most dramatic.</p>
        </div>
        <p class="help">These are WLED's AudioReactive settings under friendlier names; a converted WLED device keeps its values.</p>
      </details>
    {:else}
      {#if status.status.startsWith('turned off')}<p class="hint warn">The microphone was {status.status}. Check the pins, then turn it back on.</p>{/if}
      <p class="hint">With a microphone wired to the board, patterns can react to sound: the 🎵 Audio choices under a parameter's 🔄, and the Audio node. Choose “Simulated” as the microphone to try them without one.</p>
    {/if}

    <p class="note" class:err={noteErr} aria-live="polite">{note}&nbsp;</p>
  {/if}
</div>

<style>
  .audio { display: flex; flex-direction: column; gap: 0.7rem; }
  .field, .slider, .pin { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; }
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .row b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .lbl { opacity: 0.9; }
  i { font-style: normal; opacity: 0.5; font-size: 0.72rem; margin-left: 0.25rem; }
  .switch { display: flex; align-items: center; gap: 0.6rem; font-size: 0.9rem; }
  .switch input { width: 1.2rem; height: 1.2rem; }
  select {
    padding: 0.5rem 0.55rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.06); color: inherit; font-size: 0.95rem;
  }
  .pins { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: 0.5rem; }
  input[type=range] { width: 100%; height: 2rem; accent-color: #4f8cff; }
  .help { margin: 0; font-size: 0.75rem; opacity: 0.6; line-height: 1.35; }
  .seg { display: flex; }
  .seg button {
    flex: 1; padding: 0.55rem 0.3rem; border: 1px solid rgba(255,255,255,0.25); border-left-width: 0;
    background: rgba(255,255,255,0.06); color: #fff; font-size: 0.82rem; font-weight: 600; cursor: pointer;
  }
  .seg button:first-child { border-left-width: 1px; border-radius: 8px 0 0 8px; }
  .seg button:last-child { border-radius: 0 8px 8px 0; }
  .seg button.on { background: #4f8cff; border-color: #4f8cff; }
  .live { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.6rem; border-radius: 10px; background: rgba(255,255,255,0.04); }
  .status { margin: 0 0 0.15rem; font-size: 0.82rem; opacity: 0.9; }
  .status.warn { color: #fca5a5; }
  .meter { display: grid; grid-template-columns: 3.6rem 1fr; align-items: center; gap: 0.5rem; font-size: 0.75rem; opacity: 0.9; }
  .bar { position: relative; height: 10px; border-radius: 5px; background: rgba(255,255,255,0.08); overflow: hidden; }
  .bar > div { height: 100%; background: #4f8cff; transition: width 0.15s linear; }
  .bar.level > div { background: #a78bfa; }
  .bar.level > b { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #fff; }
  .bar.beat > div { background: #f472b6; transition: none; }
  .spectrum { display: flex; align-items: flex-end; gap: 2px; height: 44px; margin-top: 0.2rem; }
  .spectrum .col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .spectrum .col > div { width: 100%; background: linear-gradient(to top, #22d3ee, #a78bfa); border-radius: 2px 2px 0 0; transition: height 0.15s linear; }
  .btn {
    align-self: flex-start; padding: 0.45rem 0.9rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.08); color: #fff; font-size: 0.82rem; font-weight: 600; cursor: pointer;
  }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .advanced { display: flex; flex-direction: column; gap: 0.7rem; }
  .advanced > summary { cursor: pointer; font-size: 0.85rem; opacity: 0.8; padding: 0.2rem 0; }
  .advanced[open] { gap: 0.7rem; }
  .advanced[open] > *:not(summary) { margin-top: 0.6rem; }
  .hint { font-size: 0.82rem; opacity: 0.7; margin: 0; }
  .hint.warn { color: #fca5a5; opacity: 0.95; }
  .note { margin: 0; font-size: 0.78rem; color: #86efac; min-height: 1em; }
  .note.err { color: #fca5a5; }
</style>
