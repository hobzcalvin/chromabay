<script lang="ts">
  // The device's microphone, laid out like WLED's AudioReactive usermod settings (same names,
  // same mic types, same pin order) so it reads familiar and a WLED config maps straight over.
  // A live meter polls the device while this is open, so gain and squelch can be tuned by ear.
  import {
    readAudioStatus, writeAudioSettings, MIC_TYPES, MIC_PDM, MIC_MCLK, MIC_SIMULATED, AGC_MODES, FREQ_SCALES,
    type AudioStatus, type AudioSettingsPatch,
  } from '$lib/ble';

  let { deviceId }: { deviceId: string } = $props();

  let status = $state<AudioStatus | null>(null);
  let loaded = $state(false);
  let saving = $state(false);
  let msg = $state('');
  let msgErr = $state(false);

  // Form
  let en = $state(false);
  let type = $state(1);
  let sd = $state(-1), ws = $state(-1), sck = $state(-1), mclk = $state(-1);
  let sq = $state(10), gain = $state(60), agc = $state(0);
  let lim = $state(true), rise = $state(80), fall = $state(1400), scale = $state(3);

  const isPdm = $derived(type === MIC_PDM);
  const isSim = $derived(type === MIC_SIMULATED);
  const typeInfo = $derived(MIC_TYPES.find((t) => t.value === type));

  function apply(s: AudioStatus) {
    en = s.en === 1; type = s.type;
    sd = s.sd; ws = s.ws; sck = s.sck; mclk = s.mclk;
    sq = s.sq; gain = s.gain; agc = s.agc;
    lim = s.lim === 1; rise = s.rise; fall = s.fall; scale = s.scale;
  }

  async function load() {
    const s = await readAudioStatus(deviceId);
    status = s;
    if (s) apply(s);
    loaded = true;
  }

  // Poll levels while open. Settings fields are only taken from the first read so typing
  // isn't overwritten; later reads just refresh the meter and status.
  $effect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stop) return;
      if (!saving) {
        const s = await readAudioStatus(deviceId).catch(() => null);
        if (s && !stop) status = s;
      }
      timer = setTimeout(poll, 350);
    };
    load().then(() => { timer = setTimeout(poll, 350); });
    return () => { stop = true; clearTimeout(timer); };
  });

  const pinVal = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(48, Math.round(v))) : -1);

  async function save() {
    if (saving) return;
    saving = true; msg = 'Saving…'; msgErr = false;
    const patch: AudioSettingsPatch = {
      en: en ? 1 : 0, type,
      sd: pinVal(sd), ws: pinVal(ws), sck: pinVal(sck), mclk: pinVal(mclk),
      sq: Math.max(0, Math.min(255, Math.round(sq))), gain: Math.max(1, Math.min(255, Math.round(gain))),
      agc, lim: lim ? 1 : 0, rise: Math.max(0, Math.round(rise)), fall: Math.max(0, Math.round(fall)), scale,
    };
    try {
      await writeAudioSettings(deviceId, patch);
      await new Promise((r) => setTimeout(r, 400)); // let the device restart capture
      status = await readAudioStatus(deviceId);
      msg = 'Saved ✓';
    } catch (e: any) {
      msg = 'Couldn’t save: ' + (e?.message ?? e); msgErr = true;
    } finally {
      saving = false;
    }
  }

  const pct = (v: number | undefined) => `${Math.round(Math.max(0, Math.min(1, v ?? 0)) * 100)}%`;
</script>

<div class="audio">
  {#if !loaded}
    <p class="hint">Reading audio settings…</p>
  {:else if !status}
    <p class="hint">This device's firmware doesn't support audio input.</p>
  {:else}
    <label class="field check">
      <input type="checkbox" bind:checked={en} />
      <span>Enable audio input</span>
    </label>

    <label class="field row">
      <span>Microphone type</span>
      <select bind:value={type}>
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
      <div class="pins">
        <label class="field"><span>I2S SD <i>sd/data/dout</i></span><input type="number" min="-1" max="48" bind:value={sd} /></label>
        <label class="field"><span>I2S WS <i>{isPdm ? 'clk' : 'ws/clk/lrck'}</i></span><input type="number" min="-1" max="48" bind:value={ws} /></label>
        {#if !isPdm}
          <label class="field"><span>I2S SCK <i>sck/bclk</i></span><input type="number" min="-1" max="48" bind:value={sck} /></label>
        {/if}
        {#if type === MIC_MCLK}
          <label class="field"><span>I2S MCLK <i>master clock</i></span><input type="number" min="-1" max="48" bind:value={mclk} /></label>
        {/if}
      </div>
      <p class="hint">GPIO numbers; -1 = not connected. {isPdm ? 'A PDM mic has only clock (WS) and data (SD).' : 'The mic’s L/R pin can go either way; the device uses whichever slot has sound.'}</p>
    {/if}

    <div class="sub">Sound</div>
    <label class="field row"><span>Squelch</span><input type="number" min="0" max="255" bind:value={sq} /></label>
    <label class="field row"><span>Gain</span><input type="number" min="1" max="255" bind:value={gain} /></label>
    <label class="field row">
      <span>AGC</span>
      <select bind:value={agc}>{#each AGC_MODES as m, i}<option value={i}>{m}</option>{/each}</select>
    </label>

    <div class="sub">Dynamics</div>
    <label class="field row">
      <span>Limiter</span>
      <select bind:value={lim}><option value={false}>Off</option><option value={true}>On</option></select>
    </label>
    {#if lim}
      <label class="field row"><span>Rise (ms)</span><input type="number" min="0" max="5000" bind:value={rise} /></label>
      <label class="field row"><span>Fall (ms)</span><input type="number" min="0" max="10000" bind:value={fall} /></label>
    {/if}

    <div class="sub">Frequency</div>
    <label class="field row">
      <span>Scale</span>
      <select bind:value={scale}>{#each FREQ_SCALES as f (f.value)}<option value={f.value}>{f.label}</option>{/each}</select>
    </label>

    <div class="sub">Live</div>
    <p class="hint status" class:warn={status.en === 1 && status.run === 0}>
      {status.en === 1 ? status.status : 'Off'}{status.run && status.bpm > 0 ? ` · ${status.bpm.toFixed(0)} bpm` : ''}{status.run && status.hz > 0 ? ` · peak ${status.hz.toFixed(0)} Hz` : ''}
    </p>
    <div class="meters">
      <div class="meter"><span>Volume</span><div class="bar"><div style:width={pct(status.vol)}></div></div></div>
      <div class="meter"><span>Raw input</span><div class="bar raw"><div style:width={pct(Math.min(1, (status.rawpk ?? 0) * 4))}></div></div></div>
      <div class="meter"><span>Beat</span><div class="bar beat"><div style:width={pct(status.beat)}></div></div></div>
    </div>
    <div class="spectrum" aria-label="Frequency bands">
      {#each status.bands ?? [] as b}<div class="col"><div style:height={`${Math.max(2, b)}%`}></div></div>{/each}
    </div>
    <p class="hint">Raise Gain until loud music fills the Volume bar; raise Squelch until silence reads empty. AGC adjusts the gain on its own as the room gets louder or quieter.</p>

    <div class="save-bar">
      <button class="btn primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save audio settings'}</button>
      {#if msg}<span class="msg" class:err={msgErr}>{msg}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .audio { display: flex; flex-direction: column; gap: 0.55rem; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; }
  .field.row { flex-direction: row; align-items: center; justify-content: space-between; gap: 0.6rem; }
  .field.check { flex-direction: row; align-items: center; gap: 0.5rem; }
  .field > span { opacity: 0.8; }
  .field i { opacity: 0.6; font-size: 0.75rem; }
  .sub { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin-top: 0.3rem; }
  .pins { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.5rem; }
  input[type=number], select {
    padding: 0.4rem 0.55rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.06); color: inherit; font-size: 0.9rem;
  }
  .field.row input[type=number] { max-width: 6rem; }
  .meters { display: flex; flex-direction: column; gap: 0.3rem; }
  .meter { display: grid; grid-template-columns: 5.5rem 1fr; align-items: center; gap: 0.5rem; font-size: 0.78rem; opacity: 0.9; }
  .bar { height: 8px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; }
  .bar > div { height: 100%; background: #4f8cff; transition: width 0.15s linear; }
  .bar.raw > div { background: #a78bfa; }
  .bar.beat > div { background: #f472b6; transition: none; }
  .spectrum { display: flex; align-items: flex-end; gap: 2px; height: 48px; padding: 2px; border-radius: 6px; background: rgba(255,255,255,0.04); }
  .spectrum .col { flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .spectrum .col > div { width: 100%; background: linear-gradient(to top, #22d3ee, #a78bfa); border-radius: 2px 2px 0 0; transition: height 0.15s linear; }
  .hint { font-size: 0.82rem; opacity: 0.7; margin: 0; }
  .hint.warn { color: #fca5a5; opacity: 0.95; }
  .hint.status { opacity: 0.9; }
  .btn {
    padding: 0.5rem 1.4rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.08); color: #fff; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  }
  .btn.primary { background: #4f8cff; border-color: #4f8cff; }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .save-bar { display: flex; align-items: center; gap: 0.75rem; border-top: 1px solid rgba(255,255,255,0.12); padding-top: 0.6rem; }
  .msg { font-size: 0.82rem; color: #86efac; }
  .msg.err { color: #fca5a5; }
</style>
