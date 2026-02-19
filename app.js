// === Config ===
const Config = {
  STEPS: 100,
  ROWS: 24,
  MIN_NOTE: 48,  // C3
  MAX_NOTE: 71,  // B4
  CHANNELS: [
    { name: 'Lead',  waveType: 'square',   color: '#00ffff' },
    { name: 'Bass',  waveType: 'triangle', color: '#ff00ff' },
    { name: 'Arp',   waveType: 'sawtooth', color: '#00ff66' },
    { name: 'Perc',  waveType: 'noise',    color: '#ffff00' },
  ],
  NOTE_NAMES: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],
  SCALES: {
    pentatonic:    [0,2,4,7,9],
    blues:         [0,3,5,6,7,10],
    major:         [0,2,4,5,7,9,11],
    minor:         [0,2,3,5,7,8,10],
    dorian:        [0,2,3,5,7,9,10],
    chromatic:     [0,1,2,3,4,5,6,7,8,9,10,11],
    harmonicMinor: [0,2,3,5,7,8,11],
    mixolydian:    [0,2,4,5,7,9,10],
    phrygian:      [0,1,3,5,7,8,10],
    lydian:        [0,2,4,6,7,9,11],
    minorPent:     [0,3,5,7,10],
    japanese:      [0,1,5,7,8],
    wholetone:     [0,2,4,6,8,10],
    hungarian:     [0,2,3,6,7,8,11],
  },
  LOOKAHEAD: 0.1,
  SCHEDULE_INTERVAL: 25,
};

// === State ===
const State = {
  activeChannel: 0,
  patterns: Array.from({ length: 4 }, () =>
    Array.from({ length: Config.STEPS }, () => new Set())
  ),
  channels: Config.CHANNELS.map(ch => ({
    ...ch,
    volume: 0.8,
    muted: false,
    solo: false,
  })),
  bpm: 120,
  playing: false,
  looping: true,
  currentStep: 0,
  bitMode: 8, // 8, 16, or 32
  activePreset: 'chiptune',
  generate: {
    scale: 'pentatonic',
    rootNote: 0,
    density: 50,
  },
};

// === Audio Engine ===
const Audio = (() => {
  let ctx = null;
  let masterGain = null;
  let bitCrusher = null;
  let loFilter = null;
  let outputGain = null;
  let schedulerTimer = null;
  let nextStepTime = 0;
  let scheduledStep = 0;
  let noiseBuffer = null;

  // Era-accurate bit mode configs
  // 8-bit (NES): square/triangle/noise only, 1 note per channel, no FX, crunchy
  // 16-bit (SNES): + sawtooth/sine, 2 notes per channel, delay/echo, warmer
  // 32-bit (Modern): all waveforms, unlimited polyphony, delay + reverb, pristine
  const BIT_MODES = {
    8:  { quantize: 8,   cutoff: 4000,  gain: 0.55, maxPolyPerCh: 1, allowedWaves: ['square','triangle','noise'], hasDelay: false, hasReverb: false },
    16: { quantize: 128, cutoff: 12000, gain: 0.5,  maxPolyPerCh: 2, allowedWaves: ['square','triangle','sawtooth','sine','noise'], hasDelay: true, hasReverb: false },
    32: { quantize: 0,   cutoff: 22050, gain: 0.5,  maxPolyPerCh: Infinity, allowedWaves: ['square','triangle','sawtooth','sine','noise'], hasDelay: true, hasReverb: true },
  };

  // Fallback waveform mapping for restricted modes
  const WAVE_FALLBACK = { sawtooth: 'square', sine: 'triangle' };

  function makeCrusherCurve(quantizeLevels) {
    const length = 8192;
    const curve = new Float32Array(length);
    if (quantizeLevels <= 0) {
      // Linear passthrough
      for (let i = 0; i < length; i++) {
        curve[i] = (i * 2) / length - 1;
      }
    } else {
      for (let i = 0; i < length; i++) {
        const x = (i * 2) / length - 1;
        curve[i] = Math.round(x * quantizeLevels) / quantizeLevels;
      }
    }
    return curve;
  }

  // Delay/reverb nodes
  let delayNode = null, delayFeedback = null, delayWet = null;
  let reverbNode = null, reverbWet = null;

  function generateImpulseResponse(audioCtx, duration, decay) {
    const length = audioCtx.sampleRate * duration;
    const impulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.5;

    // Lowpass filter — simulates limited bandwidth at lower bit depths
    loFilter = ctx.createBiquadFilter();
    loFilter.type = 'lowpass';
    loFilter.Q.value = 0.7;

    // Bit crusher via WaveShaperNode
    bitCrusher = ctx.createWaveShaper();
    bitCrusher.oversample = 'none';

    // Output gain (compensate for volume loss from crushing)
    outputGain = ctx.createGain();

    // Delay (echo) effect
    delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.25;
    delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0.3;
    delayWet = ctx.createGain();
    delayWet.gain.value = 0;
    // Delay feedback loop
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayNode.connect(delayWet);

    // Reverb effect
    reverbNode = ctx.createConvolver();
    reverbNode.buffer = generateImpulseResponse(ctx, 1.5, 3);
    reverbWet = ctx.createGain();
    reverbWet.gain.value = 0;
    reverbNode.connect(reverbWet);

    // Signal chain: masterGain → loFilter → bitCrusher → outputGain → destination
    //                                                   ↘ delayNode → delayWet → destination
    //                                                   ↘ reverbNode → reverbWet → destination
    masterGain.connect(loFilter);
    loFilter.connect(bitCrusher);
    bitCrusher.connect(outputGain);
    outputGain.connect(ctx.destination);

    // Send from outputGain into delay and reverb
    outputGain.connect(delayNode);
    outputGain.connect(reverbNode);
    delayWet.connect(ctx.destination);
    reverbWet.connect(ctx.destination);

    // Apply initial bit mode
    applyBitMode(State.bitMode);

    // Pre-create noise buffer
    const bufferSize = ctx.sampleRate * 2;
    noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  function applyBitMode(bits) {
    const cfg = BIT_MODES[bits] || BIT_MODES[32];
    if (loFilter) loFilter.frequency.value = cfg.cutoff;
    if (bitCrusher) bitCrusher.curve = makeCrusherCurve(cfg.quantize);
    if (outputGain) outputGain.gain.value = cfg.gain;
    if (delayWet) delayWet.gain.value = cfg.hasDelay ? 0.15 : 0;
    if (reverbWet) reverbWet.gain.value = cfg.hasReverb ? 0.2 : 0;
  }

  function setBitMode(bits) {
    applyBitMode(bits);
  }

  function getAllowedWaves(bits) {
    return (BIT_MODES[bits] || BIT_MODES[32]).allowedWaves;
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function clampWaveType(waveType, bits) {
    const cfg = BIT_MODES[bits] || BIT_MODES[32];
    if (cfg.allowedWaves.includes(waveType)) return waveType;
    return WAVE_FALLBACK[waveType] || 'square';
  }

  function playNote(channelIdx, midi, time, duration) {
    const ch = State.channels[channelIdx];
    if (ch.muted) return;

    // Check solo: if any channel is soloed, only play soloed channels
    const anySolo = State.channels.some(c => c.solo);
    if (anySolo && !ch.solo) return;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(ch.volume * 0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
    gain.connect(masterGain);

    // Enforce era-appropriate waveform
    const wave = clampWaveType(ch.waveType, State.bitMode);

    if (wave === 'noise') {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      // Use midi to vary playback rate for different "pitches"
      src.playbackRate.value = midiToFreq(midi) / 440;
      src.connect(gain);
      src.start(time);
      src.stop(time + duration);
    } else {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.setValueAtTime(midiToFreq(midi), time);
      osc.connect(gain);
      osc.start(time);
      osc.stop(time + duration);
    }
  }

  function getStepDuration() {
    return 60 / State.bpm / 4; // 16th notes
  }

  function scheduleStep(step, time) {
    const dur = getStepDuration() * 0.8;
    const maxPoly = (BIT_MODES[State.bitMode] || BIT_MODES[32]).maxPolyPerCh;
    for (let ch = 0; ch < 4; ch++) {
      const notes = State.patterns[ch][step];
      if (notes && notes.size > 0) {
        let count = 0;
        for (const midi of notes) {
          if (count >= maxPoly) break;
          playNote(ch, midi, time, dur);
          count++;
        }
      }
    }
  }

  function scheduler() {
    while (nextStepTime < ctx.currentTime + Config.LOOKAHEAD) {
      scheduleStep(scheduledStep, nextStepTime);

      // Update UI playhead on main thread
      const stepToShow = scheduledStep;
      setTimeout(() => UI.updatePlayhead(stepToShow), 0);

      nextStepTime += getStepDuration();
      scheduledStep++;

      if (scheduledStep >= Config.STEPS) {
        if (State.looping) {
          scheduledStep = 0;
        } else {
          stop();
          return;
        }
      }
    }
  }

  function play() {
    init();
    if (ctx.state === 'suspended') ctx.resume();
    State.playing = true;
    scheduledStep = State.currentStep;
    nextStepTime = ctx.currentTime + 0.05;
    schedulerTimer = setInterval(scheduler, Config.SCHEDULE_INTERVAL);
    UI.onPlayStateChange();
  }

  function stop() {
    State.playing = false;
    State.currentStep = 0;
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    UI.onPlayStateChange();
  }

  function getContext() {
    init();
    return ctx;
  }

  function getNoiseBuffer() {
    init();
    return noiseBuffer;
  }

  return { init, play, stop, setBitMode, getAllowedWaves, clampWaveType, getContext, getNoiseBuffer, midiToFreq, getStepDuration };
})();

// === Style Presets ===
const Presets = {
  // --- Classic chip styles ---
  'chiptune': {
    label: 'Chiptune', scale: 'pentatonic', root: 0, bpm: 140, density: 55, progression: 'I-IV',
    waves: ['square', 'triangle', 'sawtooth', 'noise'],
    lead: { style: 'walk', jumpBias: [0.7, 0.2, 0.1], restChance: 0.1 },
    bass: { style: 'root-fifth', octave: 'low' },
    arp:  { style: 'cycle', modes: ['up','pingpong'], speed: 1 },
    perc: { kick: [0,4], snare: [2,6], hihat: 'eighths', fillChance: 0.15 },
  },
  'boss-battle': {
    label: 'Boss Battle', scale: 'harmonicMinor', root: 2, bpm: 190, density: 80, progression: 'i-iv-V-i',
    waves: ['square', 'square', 'sawtooth', 'noise'],
    lead: { style: 'heroic', jumpBias: [0.3, 0.3, 0.4], restChance: 0.03 },
    bass: { style: 'driving-eighths', octave: 'low' },
    arp:  { style: 'octave-arp', modes: ['up','down'], speed: 2 },
    perc: { kick: [0,1,2,3,4,5,6,7], snare: [4], hihat: 'sixteenths', fillChance: 0.4 },
  },
  'title-screen': {
    label: 'Title Screen', scale: 'major', root: 0, bpm: 112, density: 40, progression: 'I-vi-IV-V',
    waves: ['square', 'triangle', 'triangle', 'noise'],
    lead: { style: 'melodic', jumpBias: [0.8, 0.15, 0.05], restChance: 0.25 },
    bass: { style: 'root-fifth', octave: 'low' },
    arp:  { style: 'cycle', modes: ['pingpong'], speed: 1 },
    perc: { kick: [0], snare: [4], hihat: 'eighths', fillChance: 0.05 },
  },
  // --- Genre styles ---
  'techno': {
    label: 'Techno', scale: 'minor', root: 9, bpm: 138, density: 70, progression: 'i-VII-VI-V',
    waves: ['sawtooth', 'square', 'sawtooth', 'noise'],
    lead: { style: 'repeat', jumpBias: [0.2, 0.3, 0.5], restChance: 0.1 },
    bass: { style: 'driving-eighths', octave: 'low' },
    arp:  { style: 'stab', modes: ['up'], speed: 2 },
    perc: { kick: [0,2,4,6], snare: [4], hihat: 'sixteenths', fillChance: 0.2 },
  },
  'jazz': {
    label: 'Jazz', scale: 'dorian', root: 5, bpm: 96, density: 42, progression: 'ii-V-I',
    waves: ['triangle', 'triangle', 'sine', 'noise'],
    lead: { style: 'swing', jumpBias: [0.5, 0.3, 0.2], restChance: 0.35 },
    bass: { style: 'walking', octave: 'low' },
    arp:  { style: 'comping', modes: ['up','pingpong'], speed: 1 },
    perc: { kick: [0,5], snare: [3,7], hihat: 'swing', fillChance: 0.2 },
  },
  'rock': {
    label: 'Rock', scale: 'blues', root: 4, bpm: 128, density: 60, progression: 'I-IV-V-I',
    waves: ['square', 'sawtooth', 'square', 'noise'],
    lead: { style: 'walk', jumpBias: [0.4, 0.3, 0.3], restChance: 0.12 },
    bass: { style: 'octave', octave: 'low' },
    arp:  { style: 'power', modes: ['up','down'], speed: 1 },
    perc: { kick: [0,4], snare: [2,6], hihat: 'eighths', fillChance: 0.25 },
  },
  'ambient': {
    label: 'Ambient', scale: 'lydian', root: 7, bpm: 68, density: 18, progression: 'I-V-vi-IV',
    waves: ['sine', 'sine', 'triangle', 'noise'],
    lead: { style: 'sparse', jumpBias: [0.8, 0.15, 0.05], restChance: 0.6 },
    bass: { style: 'drone', octave: 'low' },
    arp:  { style: 'shimmer', modes: ['pingpong'], speed: 0.5 },
    perc: { kick: [], snare: [], hihat: 'sparse', fillChance: 0.02 },
  },
  'horror': {
    label: 'Horror', scale: 'chromatic', root: 1, bpm: 78, density: 30, progression: 'drone',
    waves: ['sawtooth', 'square', 'sawtooth', 'noise'],
    lead: { style: 'creep', jumpBias: [0.2, 0.2, 0.6], restChance: 0.4 },
    bass: { style: 'drone', octave: 'low' },
    arp:  { style: 'dissonant', modes: ['down'], speed: 1 },
    perc: { kick: [0,7], snare: [3], hihat: 'sparse', fillChance: 0.35 },
  },
  'funk': {
    label: 'Funk', scale: 'minorPent', root: 4, bpm: 108, density: 62, progression: 'I-bVII-IV-I',
    waves: ['square', 'sawtooth', 'square', 'noise'],
    lead: { style: 'syncopated', jumpBias: [0.5, 0.3, 0.2], restChance: 0.2 },
    bass: { style: 'syncopated', octave: 'low' },
    arp:  { style: 'comping', modes: ['up','pingpong'], speed: 1 },
    perc: { kick: [0,3,4,7], snare: [2,6], hihat: 'sixteenths', fillChance: 0.3 },
  },
  'march': {
    label: 'March', scale: 'major', root: 2, bpm: 120, density: 58, progression: 'I-IV-I-V',
    waves: ['square', 'triangle', 'sawtooth', 'noise'],
    lead: { style: 'stepwise', jumpBias: [0.85, 0.1, 0.05], restChance: 0.08 },
    bass: { style: 'march', octave: 'low' },
    arp:  { style: 'fanfare', modes: ['up'], speed: 1 },
    perc: { kick: [0,4], snare: [2,4,6], hihat: 'eighths', fillChance: 0.15 },
  },
  // --- Minecraft-inspired (C418 style) ---
  'minecraft': {
    label: 'Minecraft', scale: 'pentatonic', root: 0, bpm: 80, density: 22, progression: 'I-V-I',
    waves: ['sine', 'triangle', 'sine', 'noise'],
    lead: { style: 'floating', jumpBias: [0.6, 0.3, 0.1], restChance: 0.5 },
    bass: { style: 'pulse', octave: 'low' },
    arp:  { style: 'shimmer', modes: ['pingpong'], speed: 0.5 },
    perc: { kick: [0], snare: [], hihat: 'sparse', fillChance: 0.01 },
  },
  'minecraft-calm': {
    label: 'MC Calm', scale: 'pentatonic', root: 0, bpm: 72, density: 15, progression: 'I-V-I',
    waves: ['sine', 'sine', 'triangle', 'noise'],
    lead: { style: 'floating', jumpBias: [0.5, 0.3, 0.2], restChance: 0.65 },
    bass: { style: 'pulse', octave: 'low' },
    arp:  { style: 'shimmer', modes: ['pingpong'], speed: 0.5 },
    perc: { kick: [], snare: [], hihat: 'sparse', fillChance: 0 },
  },
  'minecraft-cave': {
    label: 'MC Cave', scale: 'chromatic', root: 9, bpm: 45, density: 10, progression: 'drone',
    waves: ['sine', 'triangle', 'sine', 'noise'],
    lead: { style: 'creep', jumpBias: [0.3, 0.2, 0.5], restChance: 0.8 },
    bass: { style: 'drone', octave: 'low' },
    arp:  { style: 'dissonant', modes: ['down'], speed: 0.5 },
    perc: { kick: [], snare: [], hihat: 'sparse', fillChance: 0 },
  },
  // --- Console game styles ---
  'zelda': {
    label: 'Zelda', scale: 'major', root: 2, bpm: 126, density: 52, progression: 'I-vi-IV-V',
    waves: ['square', 'triangle', 'square', 'noise'],
    lead: { style: 'melodic', jumpBias: [0.6, 0.25, 0.15], restChance: 0.15 },
    bass: { style: 'root-fifth', octave: 'low' },
    arp:  { style: 'fanfare', modes: ['up','pingpong'], speed: 1 },
    perc: { kick: [0,4], snare: [2,6], hihat: 'eighths', fillChance: 0.1 },
  },
  'zelda-dungeon': {
    label: 'Dungeon', scale: 'phrygian', root: 4, bpm: 88, density: 32, progression: 'i-bII-i-v',
    waves: ['square', 'triangle', 'square', 'noise'],
    lead: { style: 'creep', jumpBias: [0.4, 0.3, 0.3], restChance: 0.35 },
    bass: { style: 'drone', octave: 'low' },
    arp:  { style: 'dissonant', modes: ['down'], speed: 1 },
    perc: { kick: [0], snare: [6], hihat: 'sparse', fillChance: 0.08 },
  },
  'megaman': {
    label: 'Mega Man', scale: 'minor', root: 4, bpm: 168, density: 75, progression: 'I-III-IV-V',
    waves: ['square', 'square', 'sawtooth', 'noise'],
    lead: { style: 'heroic', jumpBias: [0.3, 0.3, 0.4], restChance: 0.05 },
    bass: { style: 'driving-eighths', octave: 'low' },
    arp:  { style: 'cycle', modes: ['up','down'], speed: 2 },
    perc: { kick: [0,2,4,6], snare: [4], hihat: 'sixteenths', fillChance: 0.3 },
  },
  'castlevania': {
    label: 'Castlevania', scale: 'harmonicMinor', root: 9, bpm: 148, density: 65, progression: 'i-VI-III-VII',
    waves: ['square', 'triangle', 'sawtooth', 'noise'],
    lead: { style: 'trill', jumpBias: [0.4, 0.3, 0.3], restChance: 0.08 },
    bass: { style: 'driving-eighths', octave: 'low' },
    arp:  { style: 'octave-arp', modes: ['up'], speed: 2 },
    perc: { kick: [0,4], snare: [2,6], hihat: 'sixteenths', fillChance: 0.2 },
  },
  'metroid': {
    label: 'Metroid', scale: 'phrygian', root: 7, bpm: 82, density: 28, progression: 'i-bII-i-v',
    waves: ['triangle', 'square', 'triangle', 'noise'],
    lead: { style: 'creep', jumpBias: [0.3, 0.2, 0.5], restChance: 0.5 },
    bass: { style: 'drone', octave: 'low' },
    arp:  { style: 'dissonant', modes: ['down','pingpong'], speed: 1 },
    perc: { kick: [0,6], snare: [], hihat: 'sparse', fillChance: 0.1 },
  },
  'kirby': {
    label: 'Kirby', scale: 'major', root: 5, bpm: 152, density: 58, progression: 'I-ii-IV-V',
    waves: ['square', 'triangle', 'square', 'noise'],
    lead: { style: 'stepwise', jumpBias: [0.7, 0.2, 0.1], restChance: 0.1 },
    bass: { style: 'root-fifth', octave: 'low' },
    arp:  { style: 'cycle', modes: ['up','pingpong'], speed: 1 },
    perc: { kick: [0,4], snare: [2,6], hihat: 'eighths', fillChance: 0.18 },
  },
  'tetris': {
    label: 'Tetris', scale: 'minor', root: 9, bpm: 155, density: 68, progression: 'i-VII-VI-VII',
    waves: ['square', 'triangle', 'square', 'noise'],
    lead: { style: 'cascade', jumpBias: [0.6, 0.3, 0.1], restChance: 0.03 },
    bass: { style: 'arpeggiated', octave: 'low' },
    arp:  { style: 'cycle', modes: ['down'], speed: 2 },
    perc: { kick: [0,4], snare: [2,6], hihat: 'eighths', fillChance: 0.15 },
  },
  'sonic': {
    label: 'Sonic', scale: 'blues', root: 4, bpm: 172, density: 72, progression: 'I-bVII-IV-I',
    waves: ['sawtooth', 'sawtooth', 'square', 'noise'],
    lead: { style: 'walk', jumpBias: [0.3, 0.3, 0.4], restChance: 0.05 },
    bass: { style: 'octave', octave: 'low' },
    arp:  { style: 'stab', modes: ['up'], speed: 2 },
    perc: { kick: [0,3,4,7], snare: [2,6], hihat: 'sixteenths', fillChance: 0.22 },
  },
  'ff-battle': {
    label: 'FF Battle', scale: 'harmonicMinor', root: 2, bpm: 162, density: 72, progression: 'i-i-iv-V',
    waves: ['square', 'triangle', 'sawtooth', 'noise'],
    lead: { style: 'heroic', jumpBias: [0.3, 0.3, 0.4], restChance: 0.03 },
    bass: { style: 'driving-eighths', octave: 'low' },
    arp:  { style: 'octave-arp', modes: ['up','down'], speed: 2 },
    perc: { kick: [0,2,4,6], snare: [4], hihat: 'sixteenths', fillChance: 0.35 },
  },
  'ff-town': {
    label: 'FF Town', scale: 'major', root: 5, bpm: 88, density: 35, progression: 'I-iii-vi-IV',
    waves: ['triangle', 'triangle', 'sine', 'noise'],
    lead: { style: 'melodic', jumpBias: [0.8, 0.15, 0.05], restChance: 0.25 },
    bass: { style: 'pulse', octave: 'low' },
    arp:  { style: 'shimmer', modes: ['pingpong'], speed: 1 },
    perc: { kick: [0], snare: [4], hihat: 'eighths', fillChance: 0.03 },
  },
  'victory': {
    label: 'Victory', scale: 'major', root: 0, bpm: 138, density: 70, progression: 'IV-V-I',
    waves: ['square', 'triangle', 'sawtooth', 'noise'],
    lead: { style: 'heroic', jumpBias: [0.4, 0.3, 0.3], restChance: 0.03 },
    bass: { style: 'march', octave: 'low' },
    arp:  { style: 'fanfare', modes: ['up'], speed: 1 },
    perc: { kick: [0,1,2,3,4,5,6,7], snare: [2,4,6], hihat: 'sixteenths', fillChance: 0.4 },
  },
  'space': {
    label: 'Space', scale: 'wholetone', root: 6, bpm: 72, density: 22, progression: 'drone',
    waves: ['sine', 'sine', 'sine', 'noise'],
    lead: { style: 'floating', jumpBias: [0.4, 0.3, 0.3], restChance: 0.55 },
    bass: { style: 'drone', octave: 'low' },
    arp:  { style: 'shimmer', modes: ['pingpong'], speed: 0.5 },
    perc: { kick: [], snare: [], hihat: 'sparse', fillChance: 0.02 },
  },
  'samurai': {
    label: 'Samurai', scale: 'japanese', root: 4, bpm: 98, density: 38, progression: 'drone',
    waves: ['triangle', 'triangle', 'triangle', 'noise'],
    lead: { style: 'call-response', jumpBias: [0.6, 0.3, 0.1], restChance: 0.25 },
    bass: { style: 'pulse', octave: 'low' },
    arp:  { style: 'cycle', modes: ['down'], speed: 1 },
    perc: { kick: [0,6], snare: [3], hihat: 'sparse', fillChance: 0.1 },
  },
  'vampire': {
    label: 'Vampire', scale: 'hungarian', root: 1, bpm: 142, density: 62, progression: 'i-VI-III-VII',
    waves: ['sawtooth', 'square', 'sawtooth', 'noise'],
    lead: { style: 'trill', jumpBias: [0.3, 0.3, 0.4], restChance: 0.08 },
    bass: { style: 'driving-eighths', octave: 'low' },
    arp:  { style: 'octave-arp', modes: ['up','down'], speed: 2 },
    perc: { kick: [0,4], snare: [2,6], hihat: 'sixteenths', fillChance: 0.22 },
  },
  'racing': {
    label: 'Racing', scale: 'mixolydian', root: 4, bpm: 185, density: 78, progression: 'I-bVII-IV-I',
    waves: ['sawtooth', 'sawtooth', 'square', 'noise'],
    lead: { style: 'repeat', jumpBias: [0.2, 0.3, 0.5], restChance: 0.03 },
    bass: { style: 'octave', octave: 'low' },
    arp:  { style: 'stab', modes: ['up'], speed: 2 },
    perc: { kick: [0,2,4,6], snare: [4], hihat: 'sixteenths', fillChance: 0.28 },
  },
  'lullaby': {
    label: 'Lullaby', scale: 'lydian', root: 7, bpm: 58, density: 18, progression: 'I-V-I',
    waves: ['sine', 'sine', 'sine', 'noise'],
    lead: { style: 'floating', jumpBias: [0.8, 0.15, 0.05], restChance: 0.5 },
    bass: { style: 'pulse', octave: 'low' },
    arp:  { style: 'shimmer', modes: ['pingpong'], speed: 0.5 },
    perc: { kick: [], snare: [], hihat: 'sparse', fillChance: 0 },
  },
  'pirate': {
    label: 'Pirate', scale: 'dorian', root: 2, bpm: 142, density: 58, progression: 'i-VII-VI-V',
    waves: ['square', 'triangle', 'sawtooth', 'noise'],
    lead: { style: 'cascade', jumpBias: [0.5, 0.3, 0.2], restChance: 0.08 },
    bass: { style: 'arpeggiated', octave: 'low' },
    arp:  { style: 'cycle', modes: ['up','down'], speed: 1 },
    perc: { kick: [0,3,4,7], snare: [2,6], hihat: 'eighths', fillChance: 0.22 },
  },
};

// === Generator ===
const Generator = (() => {
  // --- Chord progression definitions ---
  // Each chord: { degree (0-based scale degree), type, steps (duration out of 100) }
  const PROGRESSIONS = {
    'I-IV': [
      { degree: 0, type: 'triad', steps: 50 },
      { degree: 3, type: 'triad', steps: 50 },
    ],
    'I-IV-V-I': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
      { degree: 0, type: 'triad', steps: 25 },
    ],
    'i-iv-V-i': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
      { degree: 0, type: 'triad', steps: 25 },
    ],
    'I-vi-IV-V': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 5, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
    ],
    'i-VII-VI-V': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 6, type: 'triad', steps: 25 },
      { degree: 5, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
    ],
    'ii-V-I': [
      { degree: 1, type: 'seventh', steps: 34 },
      { degree: 4, type: 'seventh', steps: 33 },
      { degree: 0, type: 'seventh', steps: 33 },
    ],
    'I-V-vi-IV': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
      { degree: 5, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
    ],
    'drone': [
      { degree: 0, type: 'triad', steps: 100 },
    ],
    'I-bVII-IV-I': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 6, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 0, type: 'triad', steps: 25 },
    ],
    'I-IV-I-V': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
    ],
    // Minecraft-style: gentle, open, floating
    'I-V-I': [
      { degree: 0, type: 'triad', steps: 34 },
      { degree: 4, type: 'triad', steps: 33 },
      { degree: 0, type: 'triad', steps: 33 },
    ],
    // Zelda dungeon: dark, mysterious
    'i-bII-i-v': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 1, type: 'triad', steps: 25 },
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
    ],
    // Mega Man stage select / action
    'I-III-IV-V': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 2, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
    ],
    // Victory / fanfare
    'IV-V-I': [
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
      { degree: 0, type: 'triad', steps: 50 },
    ],
    // Castlevania / gothic
    'i-VI-III-VII': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 5, type: 'triad', steps: 25 },
      { degree: 2, type: 'triad', steps: 25 },
      { degree: 6, type: 'triad', steps: 25 },
    ],
    // Dreamy / RPG town
    'I-iii-vi-IV': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 2, type: 'triad', steps: 25 },
      { degree: 5, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
    ],
    // Tension / boss intro
    'i-i-iv-V': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
    ],
    // Kirby / cute platformer
    'I-ii-IV-V': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 1, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
    ],
    // Space / sci-fi
    'i-III-v-IV': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 2, type: 'triad', steps: 25 },
      { degree: 4, type: 'triad', steps: 25 },
      { degree: 3, type: 'triad', steps: 25 },
    ],
    // Tetris / Eastern European
    'i-VII-VI-VII': [
      { degree: 0, type: 'triad', steps: 25 },
      { degree: 6, type: 'triad', steps: 25 },
      { degree: 5, type: 'triad', steps: 25 },
      { degree: 6, type: 'triad', steps: 25 },
    ],
  };

  function getScaleNotes(scaleName, root) {
    const intervals = Config.SCALES[scaleName];
    const notes = [];
    for (let midi = Config.MIN_NOTE; midi <= Config.MAX_NOTE; midi++) {
      if (intervals.includes((midi - root + 120) % 12)) {
        notes.push(midi);
      }
    }
    return notes;
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function wrapIdx(idx, len) { return ((idx % len) + len) % len; }

  function isStrongBeat(step) { return step % 4 === 0; }
  function isPhraseBoundary(step) { return step % 16 === 0; }

  // Build chord map: array[100] where each entry has { rootMidi, tones[], degree }
  function buildChordMap(scaleName, root, progressionKey) {
    const intervals = Config.SCALES[scaleName];
    const prog = PROGRESSIONS[progressionKey] || PROGRESSIONS['I-IV-V-I'];

    // Build diatonic scale degrees from root
    // For each degree, stack thirds diatonically to build triads/sevenths
    function getDiatonicNote(degree, root) {
      const idx = ((degree % intervals.length) + intervals.length) % intervals.length;
      const octaveShift = Math.floor(degree / intervals.length);
      return root + intervals[idx] + octaveShift * 12;
    }

    function buildChordTones(degree, type) {
      const r = getDiatonicNote(degree, root);
      const third = getDiatonicNote(degree + 2, root);
      const fifth = getDiatonicNote(degree + 4, root);
      const tones = [r % 12, third % 12, fifth % 12];
      if (type === 'seventh') {
        const seventh = getDiatonicNote(degree + 6, root);
        tones.push(seventh % 12);
      }
      return { rootPc: r % 12, tones };
    }

    const map = new Array(Config.STEPS);
    let pos = 0;
    for (const chord of prog) {
      const { rootPc, tones } = buildChordTones(chord.degree, chord.type);
      const end = pos + chord.steps;
      for (let s = pos; s < end && s < Config.STEPS; s++) {
        map[s] = { rootPc, tones, degree: chord.degree };
      }
      pos = end;
    }
    // Fill any remaining steps with last chord
    const last = map[pos - 1] || map[0];
    for (let s = pos; s < Config.STEPS; s++) {
      map[s] = last;
    }
    return map;
  }

  // Snap index to nearest chord tone in the scale notes array
  function snapToChordTone(idx, notes, chord) {
    const tones = chord.tones;
    let bestDist = Infinity;
    let bestIdx = idx;
    // Search within ±6 of current position
    for (let offset = -6; offset <= 6; offset++) {
      const candidate = wrapIdx(idx + offset, notes.length);
      if (tones.includes(notes[candidate] % 12)) {
        if (Math.abs(offset) < bestDist) {
          bestDist = Math.abs(offset);
          bestIdx = candidate;
        }
      }
    }
    return bestIdx;
  }

  // Find a bass note matching a pitch class in the bass range
  function findBassNote(notes, pc) {
    return notes.find(n => (n % 12) === pc) || notes[0];
  }

  // --- Lead generator ---
  function generateLead(scale, root, density, style, chordMap) {
    const notes = getScaleNotes(scale, root);
    if (notes.length === 0) return;
    const pattern = State.patterns[0];
    const bias = style.jumpBias || [0.7, 0.2, 0.1];
    let idx = Math.floor(notes.length / 2);
    let direction = 1; // for stepwise

    // Fix repeat style: decide hold length once per phrase, not per step
    let repeatHoldEnd = 0;

    // A/B phrase structure: nudge center for variety
    function phraseCenter(step) {
      const phrase32 = Math.floor(step / 32);
      // Alternate: A phrases center lower, B phrases center higher
      const offset = (phrase32 % 2 === 0) ? -2 : 2;
      return Math.floor(notes.length / 2) + offset;
    }

    for (let step = 0; step < Config.STEPS; step++) {
      pattern[step].clear();

      // Rest chance
      if (Math.random() < (style.restChance || 0.1)) continue;
      if (Math.random() * 100 > density) continue;

      const chord = chordMap[step];

      // Repeat style: hold note for fixed duration then jump
      if (style.style === 'repeat') {
        if (step >= repeatHoldEnd) {
          const r = Math.random();
          let jump = r < 0.5 ? pick([-2,-1,1,2]) : pick([-4,-3,3,4]);
          idx = wrapIdx(idx + jump, notes.length);
          repeatHoldEnd = step + 2 + Math.floor(Math.random() * 3);
        }
      }
      // Syncopated: off-beat emphasis
      else if (style.style === 'syncopated') {
        if (step % 2 === 0 && Math.random() < 0.4) continue;
        const r = Math.random();
        let jump = r < bias[0] ? pick([-1,1]) : r < bias[0]+bias[1] ? pick([-2,2]) : pick([-3,-2,2,3]);
        idx = wrapIdx(idx + jump, notes.length);
      }
      // Swing: dotted rhythm feel
      else if (style.style === 'swing') {
        if (step % 4 === 2 && Math.random() < 0.5) continue;
        const r = Math.random();
        let jump = r < bias[0] ? pick([-1,1]) : pick([-3,-2,2,3]);
        idx = wrapIdx(idx + jump, notes.length);
      }
      // Creep: small moves with occasional leaps
      else if (style.style === 'creep') {
        const r = Math.random();
        let jump = r < 0.5 ? pick([-1,1]) : r < 0.8 ? pick([-2,2]) : pick([-5,-4,4,5]);
        idx = wrapIdx(idx + jump, notes.length);
      }
      // Sparse: mostly rests with long notes
      else if (style.style === 'sparse') {
        if (step % 8 !== 0 && Math.random() < 0.7) continue;
        const r = Math.random();
        let jump = r < bias[0] ? pick([-1,0,1]) : pick([-2,2]);
        idx = wrapIdx(idx + jump, notes.length);
      }
      // Stepwise: march-like scalar runs
      else if (style.style === 'stepwise') {
        if (step % 4 === 0) {
          direction = Math.random() < 0.5 ? 1 : -1;
        }
        idx = wrapIdx(idx + direction, notes.length);
      }
      // Melodic: lyrical, longer phrases with A/B structure
      else if (style.style === 'melodic') {
        if (step % 8 < 2) {
          const center = phraseCenter(step);
          idx = wrapIdx(center + pick([-2,-1,0,1,2]), notes.length);
        } else {
          const r = Math.random();
          let jump = r < bias[0] ? pick([-1,1]) : r < bias[0]+bias[1] ? pick([-2,2]) : 0;
          idx = wrapIdx(idx + jump, notes.length);
        }
      }
      // Floating: Minecraft-style, sparse dreamy notes with large gentle intervals
      else if (style.style === 'floating') {
        if (step % 4 !== 0 && Math.random() < 0.6) continue;
        const r = Math.random();
        let jump = r < 0.4 ? pick([-2,-1,1,2]) : r < 0.7 ? pick([-4,-3,3,4]) : pick([-5,5]);
        idx = wrapIdx(idx + jump, notes.length);
      }
      // Heroic: bold leaps on downbeats, stepwise fills between
      else if (style.style === 'heroic') {
        if (isStrongBeat(step)) {
          const jump = pick([-4,-3,3,4,5]);
          idx = wrapIdx(idx + jump, notes.length);
        } else {
          idx = wrapIdx(idx + pick([-1,1]), notes.length);
        }
      }
      // Trill: rapid alternation between two adjacent notes
      else if (style.style === 'trill') {
        if (step % 16 === 0) {
          idx = wrapIdx(idx + pick([-3,-2,2,3]), notes.length);
        }
        const alt = (step % 2 === 0) ? 0 : 1;
        const trillIdx = wrapIdx(idx + alt, notes.length);
        pattern[step].add(notes[trillIdx]);
        continue; // skip the add at end
      }
      // Call-response: 4 steps of melody, 4 steps of echo shifted
      else if (style.style === 'call-response') {
        const phrase = step % 8;
        if (phrase < 4) {
          const r = Math.random();
          let jump = r < bias[0] ? pick([-1,1]) : pick([-2,2]);
          idx = wrapIdx(idx + jump, notes.length);
        } else {
          // Echo the call shifted up/down
          const shift = (Math.floor(step / 16) % 2 === 0) ? 2 : -2;
          idx = wrapIdx(idx + shift + pick([-1,0,0,1]), notes.length);
        }
      }
      // Cascade: descending runs that reset at phrase boundaries
      else if (style.style === 'cascade') {
        if (step % 16 === 0) {
          idx = Math.min(notes.length - 1, Math.floor(notes.length * 0.8) + Math.floor(Math.random() * 3));
        }
        idx = wrapIdx(idx - 1, notes.length);
      }
      // Default walk
      else {
        const r = Math.random();
        let jump;
        if (r < bias[0]) jump = pick([-1, 1]);
        else if (r < bias[0] + bias[1]) jump = pick([-2, 2]);
        else jump = Math.floor(Math.random() * 7) - 3;
        idx = wrapIdx(idx + jump, notes.length);
      }

      // Chord targeting: snap to chord tones on strong beats and phrase starts
      if (isPhraseBoundary(step) && Math.random() < 0.8) {
        idx = snapToChordTone(idx, notes, chord);
      } else if (isStrongBeat(step) && Math.random() < 0.5) {
        idx = snapToChordTone(idx, notes, chord);
      }

      // A/B phrase: gently pull toward phrase center
      if (step % 32 === 0) {
        const center = phraseCenter(step);
        const pull = center > idx ? 1 : center < idx ? -1 : 0;
        idx = wrapIdx(idx + pull, notes.length);
      }

      pattern[step].add(notes[idx]);
    }
  }

  // --- Bass generator ---
  function generateBass(scale, root, density, style, chordMap) {
    const notes = getScaleNotes(scale, root).filter(n => n < 60);
    if (notes.length === 0) return;
    const pattern = State.patterns[1];

    for (let step = 0; step < Config.STEPS; step++) {
      pattern[step].clear();
    }

    if (style.style === 'driving-eighths') {
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.5) continue;
        const chord = chordMap[step];
        const note = findBassNote(notes, chord.rootPc);
        // Chromatic approach at chord changes
        if (step > 0 && chordMap[step - 1].rootPc !== chord.rootPc && step % 2 === 1) {
          const approach = note + (Math.random() < 0.5 ? 1 : -1);
          if (approach >= Config.MIN_NOTE) pattern[step].add(approach);
          else pattern[step].add(note);
        } else if (step % 2 === 0 || Math.random() < 0.6) {
          pattern[step].add(note);
        }
      }
    } else if (style.style === 'walking') {
      let idx = 0;
      for (let step = 0; step < Config.STEPS; step++) {
        if (step % 2 !== 0 && Math.random() < 0.3) continue;
        const chord = chordMap[step];
        // On chord changes, target the new root
        if (step > 0 && chordMap[step - 1].rootPc !== chord.rootPc) {
          const target = findBassNote(notes, chord.rootPc);
          const targetIdx = notes.indexOf(target);
          if (targetIdx >= 0) idx = targetIdx;
          // Chromatic approach: play a half-step below on previous step
          if (step > 0 && pattern[step - 1].size === 0) {
            pattern[step - 1].add(target - 1);
          }
        }
        pattern[step].add(notes[idx]);
        const jump = Math.random() < 0.7 ? pick([-1,1]) : pick([-2,2]);
        idx = wrapIdx(idx + jump, notes.length);
      }
    } else if (style.style === 'drone') {
      for (let step = 0; step < Config.STEPS; step++) {
        const chord = chordMap[step];
        const rootNote = findBassNote(notes, chord.rootPc);
        if (step % 4 === 0) {
          pattern[step].add(rootNote);
        } else if (step % 8 === 4 && Math.random() < 0.3) {
          const fifthPc = chord.tones[2] !== undefined ? chord.tones[2] : chord.rootPc;
          pattern[step].add(findBassNote(notes, fifthPc));
        }
      }
    } else if (style.style === 'syncopated') {
      for (let step = 0; step < Config.STEPS; step++) {
        const chord = chordMap[step];
        const rootNote = findBassNote(notes, chord.rootPc);
        const fifthPc = chord.tones[2] !== undefined ? chord.tones[2] : chord.rootPc;
        const thirdPc = chord.tones[1] !== undefined ? chord.tones[1] : chord.rootPc;
        const beat = step % 8;
        if (beat === 0) pattern[step].add(rootNote);
        else if (beat === 3) pattern[step].add(rootNote);
        else if (beat === 5 && Math.random() < 0.7) pattern[step].add(findBassNote(notes, fifthPc));
        else if (beat === 7 && Math.random() < 0.5) pattern[step].add(findBassNote(notes, thirdPc));
        else if (Math.random() < 0.15) pattern[step].add(pick(notes));
      }
    } else if (style.style === 'march') {
      for (let step = 0; step < Config.STEPS; step++) {
        const chord = chordMap[step];
        const rootNote = findBassNote(notes, chord.rootPc);
        const fifthPc = chord.tones[2] !== undefined ? chord.tones[2] : chord.rootPc;
        const beat = step % 8;
        if (beat === 0 || beat === 4) pattern[step].add(rootNote);
        else if (beat === 2 || beat === 6) pattern[step].add(findBassNote(notes, fifthPc));
      }
    } else if (style.style === 'pulse') {
      // Minecraft-style: very sparse, just a gentle low pulse
      for (let step = 0; step < Config.STEPS; step++) {
        const chord = chordMap[step];
        const rootNote = findBassNote(notes, chord.rootPc);
        if (step % 8 === 0) {
          pattern[step].add(rootNote);
        } else if (step % 16 === 8 && Math.random() < 0.4) {
          const fifthPc = chord.tones[2] !== undefined ? chord.tones[2] : chord.rootPc;
          pattern[step].add(findBassNote(notes, fifthPc));
        }
      }
    } else if (style.style === 'octave') {
      // Alternating root octave jumps
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.3) continue;
        const chord = chordMap[step];
        const rootNote = findBassNote(notes, chord.rootPc);
        const beat = step % 4;
        if (beat === 0) pattern[step].add(rootNote);
        else if (beat === 2) {
          const upper = rootNote + 12 <= Config.MAX_NOTE ? rootNote + 12 : rootNote;
          pattern[step].add(upper);
        }
      }
    } else if (style.style === 'arpeggiated') {
      // Bass plays chord tones in sequence
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.3) continue;
        const chord = chordMap[step];
        const bassNotes = chord.tones.map(pc => findBassNote(notes, pc)).filter(Boolean);
        if (bassNotes.length > 0) {
          pattern[step].add(bassNotes[step % bassNotes.length]);
        }
      }
    }
    // Default root-fifth using chordMap
    else {
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.2) continue;
        const chord = chordMap[step];
        const rootNote = findBassNote(notes, chord.rootPc);
        const fifthPc = chord.tones[2] !== undefined ? chord.tones[2] : chord.rootPc;
        const beat = step % 8;
        if (beat === 0 || beat === 4) pattern[step].add(rootNote);
        else if (beat === 2 || beat === 6) pattern[step].add(findBassNote(notes, fifthPc));
        else if (Math.random() < 0.3) pattern[step].add(pick(notes));
      }
    }
  }

  // --- Arp generator ---
  function generateArp(scale, root, density, style, chordMap) {
    const notes = getScaleNotes(scale, root);
    if (notes.length < 3) return;
    const pattern = State.patterns[2];

    // Get chord tones from chordMap as actual MIDI notes within the arp range
    function getChordMidiTones(step) {
      const chord = chordMap[step];
      const tones = [];
      for (const note of notes) {
        if (chord.tones.includes(note % 12)) {
          tones.push(note);
        }
      }
      return tones.length > 0 ? tones : [notes[0], notes[2], notes[4] % notes.length];
    }

    for (let step = 0; step < Config.STEPS; step++) {
      pattern[step].clear();
    }

    if (style.style === 'comping') {
      for (let step = 0; step < Config.STEPS; step++) {
        const beat = step % 8;
        if ((beat === 0 || beat === 3 || beat === 6) && Math.random() * 100 < density * 1.2) {
          const chord = getChordMidiTones(step);
          const count = Math.min(2 + Math.floor(Math.random() * 2), chord.length);
          for (let i = 0; i < count; i++) {
            pattern[step].add(chord[i]);
          }
        }
      }
    } else if (style.style === 'power') {
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.2) continue;
        if (step % 2 === 0) {
          const chord = getChordMidiTones(step);
          pattern[step].add(chord[0]);
          if (chord.length > 1) pattern[step].add(chord[Math.min(1, chord.length - 1)]);
        }
      }
    } else if (style.style === 'dissonant') {
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density) continue;
        const chord = getChordMidiTones(step);
        const base = pick(chord);
        pattern[step].add(base);
        const dissonant = notes.find(n => Math.abs(n - base) === 1 || Math.abs(n - base) === 6);
        if (dissonant) pattern[step].add(dissonant);
      }
    } else if (style.style === 'fanfare') {
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.2) continue;
        const chord = getChordMidiTones(step);
        const pos = step % chord.length;
        pattern[step].add(chord[pos]);
      }
    } else if (style.style === 'shimmer') {
      // Minecraft-style: sparse random chord tones, dreamy
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() > 0.25) continue;
        const chord = getChordMidiTones(step);
        if (chord.length > 0) {
          // Pick a random high chord tone
          const high = chord.filter(n => n >= 60);
          const pool = high.length > 0 ? high : chord;
          pattern[step].add(pick(pool));
          if (Math.random() < 0.3 && pool.length > 1) {
            pattern[step].add(pick(pool));
          }
        }
      }
    } else if (style.style === 'stab') {
      // Short rhythmic chord stabs on offbeats
      for (let step = 0; step < Config.STEPS; step++) {
        const beat = step % 8;
        if ((beat === 1 || beat === 3 || beat === 5) && Math.random() * 100 < density) {
          const chord = getChordMidiTones(step);
          const count = Math.min(3, chord.length);
          for (let i = 0; i < count; i++) {
            pattern[step].add(chord[i]);
          }
        }
      }
    } else if (style.style === 'octave-arp') {
      // Fast octave arpeggios — root then root+12
      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.3) continue;
        const chord = getChordMidiTones(step);
        if (chord.length === 0) continue;
        const base = chord[step % chord.length];
        if (step % 2 === 0) {
          pattern[step].add(base);
        } else {
          const upper = base + 12 <= Config.MAX_NOTE ? base + 12 : base;
          pattern[step].add(upper);
        }
      }
    }
    // Default cycle — uses per-step chord tones
    else {
      const modes = style.modes || ['up','down','pingpong'];
      const mode = pick(modes);

      for (let step = 0; step < Config.STEPS; step++) {
        if (Math.random() * 100 > density * 1.3) continue;
        const chord = getChordMidiTones(step);
        if (chord.length === 0) continue;

        let noteIdx;
        if (mode === 'up') {
          noteIdx = step % chord.length;
        } else if (mode === 'down') {
          noteIdx = (chord.length - 1) - (step % chord.length);
        } else {
          // pingpong
          const cycle = Math.max(1, chord.length * 2 - 2);
          const pos = step % cycle;
          noteIdx = pos < chord.length ? pos : cycle - pos;
          noteIdx = Math.min(noteIdx, chord.length - 1);
        }
        pattern[step].add(chord[noteIdx]);
      }
    }
  }

  // --- Percussion generator ---
  function generatePerc(density, style) {
    const pattern = State.patterns[3];
    const kick = 48, snare = 55, hihat = 64;

    for (let step = 0; step < Config.STEPS; step++) {
      pattern[step].clear();
      const beat = step % 8;
      const phrasePos = step % 16;

      // Kick pattern
      if ((style.kick || [0,4]).includes(beat)) {
        pattern[step].add(kick);
      }

      // Snare pattern
      if ((style.snare || [2,6]).includes(beat)) {
        pattern[step].add(snare);
      }

      // Hi-hat pattern
      const hh = style.hihat || 'eighths';
      if (hh === 'sixteenths') {
        if (Math.random() * 100 < density * 1.2) pattern[step].add(hihat);
      } else if (hh === 'swing') {
        if ([0,1,3,4,5,7].includes(beat) && Math.random() * 100 < density) pattern[step].add(hihat);
      } else if (hh === 'sparse') {
        if (step % 4 === 0 && Math.random() < 0.6) pattern[step].add(hihat);
      } else {
        if (step % 2 === 0 && Math.random() * 100 < density) pattern[step].add(hihat);
      }

      // Fills: cluster at phrase boundaries (last 2 steps of 16-step phrases)
      const fillChance = style.fillChance || 0.15;
      if (phrasePos >= 14) {
        // 5x fill chance at phrase endings
        if (Math.random() < fillChance * 5) {
          pattern[step].add(pick([kick, snare, hihat]));
        }
      } else if (phrasePos < 12) {
        // Suppress random fills in middle of phrase
        if (Math.random() < fillChance * 0.2) {
          pattern[step].add(pick([kick, snare, hihat]));
        }
      }
    }
  }

  // --- Apply preset ---
  function applyPreset(presetName) {
    const p = Presets[presetName];
    if (!p) return;

    State.activePreset = presetName;
    State.generate.scale = p.scale;
    State.generate.rootNote = p.root;
    State.generate.density = p.density;
    State.bpm = p.bpm;

    if (p.waves) {
      p.waves.forEach((w, i) => { State.channels[i].waveType = w; });
    }
  }

  function generateAll() {
    const p = Presets[State.activePreset] || Presets['chiptune'];
    const { scale, rootNote, density } = State.generate;

    const chordMap = buildChordMap(scale, rootNote, p.progression || 'I-IV-V-I');

    generateLead(scale, rootNote, density, p.lead, chordMap);
    generateBass(scale, rootNote, density, p.bass, chordMap);
    generateArp(scale, rootNote, density, p.arp, chordMap);
    generatePerc(density, p.perc);
    UI.renderGrid();
  }

  function generateRandom() {
    // Pick a random scale, root, density, BPM, waves, and preset style
    const scaleNames = Object.keys(Config.SCALES);
    const presetNames = Object.keys(Presets);
    const allWaves = ['square', 'triangle', 'sawtooth', 'sine', 'noise'];

    const randScale = pick(scaleNames);
    const randRoot = Math.floor(Math.random() * 12);
    const randDensity = 20 + Math.floor(Math.random() * 65);
    const randBpm = 55 + Math.floor(Math.random() * 160);
    const randPreset = pick(presetNames);
    const p = Presets[randPreset];

    // Apply random settings to state
    State.generate.scale = randScale;
    State.generate.rootNote = randRoot;
    State.generate.density = randDensity;
    State.bpm = randBpm;
    State.activePreset = randPreset;

    // Randomize wave types per channel
    State.channels[0].waveType = pick(allWaves.filter(w => w !== 'noise'));
    State.channels[1].waveType = pick(allWaves.filter(w => w !== 'noise'));
    State.channels[2].waveType = pick(allWaves.filter(w => w !== 'noise'));
    State.channels[3].waveType = 'noise';

    // Pick random progression
    const progNames = Object.keys(PROGRESSIONS);
    const randProg = pick(progNames);

    // Pick random lead/bass/arp/perc styles from random presets
    const randLeadPreset = Presets[pick(presetNames)];
    const randBassPreset = Presets[pick(presetNames)];
    const randArpPreset = Presets[pick(presetNames)];
    const randPercPreset = Presets[pick(presetNames)];

    const chordMap = buildChordMap(randScale, randRoot, randProg);

    generateLead(randScale, randRoot, randDensity, randLeadPreset.lead, chordMap);
    generateBass(randScale, randRoot, randDensity, randBassPreset.bass, chordMap);
    generateArp(randScale, randRoot, randDensity, randArpPreset.arp, chordMap);
    generatePerc(randDensity, randPercPreset.perc);
    UI.renderGrid();
  }

  function clearAll() {
    for (let ch = 0; ch < 4; ch++) {
      for (let step = 0; step < Config.STEPS; step++) {
        State.patterns[ch][step].clear();
      }
    }
    UI.renderGrid();
  }

  return { generateAll, generateRandom, clearAll, applyPreset };
})();

// === Exporter ===
const Exporter = (() => {
  function exportWAV(customDurationSec) {
    const sampleRate = 44100;
    const stepDur = Audio.getStepDuration();
    if (!Number.isFinite(stepDur) || stepDur <= 0) {
      alert('Set BPM above 0 before exporting.');
      return;
    }
    const patternDuration = Config.STEPS * stepDur;
    const wantDuration = (Number.isFinite(customDurationSec) && customDurationSec > 0)
      ? customDurationSec
      : patternDuration;

    // Render ONE pattern loop + tail for effects, then tile the audio to fill duration
    const loopRenderDur = patternDuration + 2; // +2s for delay/reverb tail
    console.log(`Export: rendering 1 loop (${patternDuration.toFixed(1)}s), tiling to ${wantDuration.toFixed(1)}s`);

    const offlineCtx = new OfflineAudioContext(2, Math.ceil(loopRenderDur * sampleRate), sampleRate);

    const masterGain = offlineCtx.createGain();
    masterGain.gain.value = 0.5;

    const bitCfg = {
      8:  { q: 8,   cut: 4000,  g: 0.55, maxPoly: 1,        hasDelay: false, hasReverb: false },
      16: { q: 128, cut: 12000, g: 0.5,  maxPoly: 2,        hasDelay: true,  hasReverb: false },
      32: { q: 0,   cut: 22050, g: 0.5,  maxPoly: Infinity, hasDelay: true,  hasReverb: true  },
    };
    const cfg = bitCfg[State.bitMode] || bitCfg[32];

    const loFilter = offlineCtx.createBiquadFilter();
    loFilter.type = 'lowpass';
    loFilter.frequency.value = cfg.cut;
    loFilter.Q.value = 0.7;

    const crusher = offlineCtx.createWaveShaper();
    crusher.oversample = 'none';
    const curveLen = 8192;
    const curve = new Float32Array(curveLen);
    if (cfg.q <= 0) {
      for (let i = 0; i < curveLen; i++) curve[i] = (i * 2) / curveLen - 1;
    } else {
      for (let i = 0; i < curveLen; i++) {
        const x = (i * 2) / curveLen - 1;
        curve[i] = Math.round(x * cfg.q) / cfg.q;
      }
    }
    crusher.curve = curve;

    const outGain = offlineCtx.createGain();
    outGain.gain.value = cfg.g;

    masterGain.connect(loFilter);
    loFilter.connect(crusher);
    crusher.connect(outGain);
    outGain.connect(offlineCtx.destination);

    if (cfg.hasDelay) {
      const delay = offlineCtx.createDelay(1.0);
      delay.delayTime.value = 0.25;
      const fb = offlineCtx.createGain();
      fb.gain.value = 0.3;
      const wet = offlineCtx.createGain();
      wet.gain.value = 0.15;
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(wet);
      outGain.connect(delay);
      wet.connect(offlineCtx.destination);
    }

    if (cfg.hasReverb) {
      const convolver = offlineCtx.createConvolver();
      const irLength = sampleRate * 1.5;
      const ir = offlineCtx.createBuffer(2, irLength, sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < irLength; i++) {
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLength, 3);
        }
      }
      convolver.buffer = ir;
      const rWet = offlineCtx.createGain();
      rWet.gain.value = 0.2;
      convolver.connect(rWet);
      outGain.connect(convolver);
      rWet.connect(offlineCtx.destination);
    }

    const bufferSize = sampleRate * 2;
    const noiseBuffer = offlineCtx.createBuffer(1, bufferSize, sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      noiseData[i] = Math.random() * 2 - 1;
    }

    // Schedule exactly one pattern loop
    for (let ch = 0; ch < 4; ch++) {
      const channelCfg = State.channels[ch];
      if (channelCfg.muted) continue;
      const anySolo = State.channels.some(c => c.solo);
      if (anySolo && !channelCfg.solo) continue;

      const wave = Audio.clampWaveType(channelCfg.waveType, State.bitMode);

      for (let s = 0; s < Config.STEPS; s++) {
        const notes = State.patterns[ch][s];
        if (!notes || notes.size === 0) continue;

        const time = s * stepDur;
        const dur = stepDur * 0.8;

        let count = 0;
        for (const midi of notes) {
          if (count >= cfg.maxPoly) break;

          const gain = offlineCtx.createGain();
          gain.gain.setValueAtTime(channelCfg.volume * 0.3, time);
          gain.gain.exponentialRampToValueAtTime(0.001, time + dur);
          gain.connect(masterGain);

          if (wave === 'noise') {
            const src = offlineCtx.createBufferSource();
            src.buffer = noiseBuffer;
            src.playbackRate.value = Audio.midiToFreq(midi) / 440;
            src.connect(gain);
            src.start(time);
            src.stop(time + dur);
          } else {
            const osc = offlineCtx.createOscillator();
            osc.type = wave;
            osc.frequency.setValueAtTime(Audio.midiToFreq(midi), time);
            osc.connect(gain);
            osc.start(time);
            osc.stop(time + dur);
          }
          count++;
        }
      }
    }

    offlineCtx.startRendering().then(loopBuffer => {
      // Tile the rendered loop to fill the requested duration
      const blob = encodeWAVTiled(loopBuffer, patternDuration, wantDuration);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Build descriptive filename: style_scale_root_BPM_bitmode_seq.wav
      const style = (State.activePreset || 'unknown').replace(/[^a-zA-Z0-9-]/g, '');
      const scale = (State.generate.scale || 'pentatonic').replace(/[^a-zA-Z]/g, '');
      const root = Config.NOTE_NAMES[State.generate.rootNote] || 'C';
      const bpm = State.bpm || 120;
      const bits = State.bitMode || 8;
      const seq = String(Date.now()).slice(-10);
      a.download = `${style}_${scale}_${root}_${bpm}bpm_${bits}bit_${seq}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log('Export complete:', (wantDuration).toFixed(1) + 's');
    }).catch(err => {
      console.error('Rendering failed:', err);
      alert('Export rendering failed: ' + err.message);
    });
  }

  // Pre-encode one loop of audio into an interleaved Int16Array (fast, typed array)
  function encodeLoopChunk(loopBuffer, loopSamples) {
    const numCh = loopBuffer.numberOfChannels;
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(loopBuffer.getChannelData(c));

    const chunk = new Int16Array(loopSamples * numCh);
    let idx = 0;
    for (let i = 0; i < loopSamples; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        chunk[idx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
    }
    return chunk;
  }

  // Build WAV as Blob from chunks — avoids allocating one giant ArrayBuffer
  function encodeWAVTiled(loopBuffer, loopDurationSec, totalDurationSec) {
    const numCh = loopBuffer.numberOfChannels;
    const sampleRate = loopBuffer.sampleRate;
    const loopSamples = Math.round(loopDurationSec * sampleRate);
    const totalSamples = Math.round(totalDurationSec * sampleRate);
    const dataSize = totalSamples * numCh * 2;

    // 44-byte WAV header
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    function ws(off, str) { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); }
    ws(0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, numCh, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * numCh * 2, true);
    v.setUint16(32, numCh * 2, true);
    v.setUint16(34, 16, true);
    ws(36, 'data');
    v.setUint32(40, dataSize, true);

    // Encode one loop as Int16 interleaved PCM
    const loopChunk = encodeLoopChunk(loopBuffer, loopSamples);
    const loopBytes = new Uint8Array(loopChunk.buffer);

    // Build blob from header + repeated loop chunks
    const parts = [header];
    const fullLoops = Math.floor(totalSamples / loopSamples);
    const remainSamples = totalSamples % loopSamples;

    for (let i = 0; i < fullLoops; i++) {
      parts.push(loopBytes);
    }

    // Partial final loop
    if (remainSamples > 0) {
      const partialBytes = remainSamples * numCh * 2;
      parts.push(loopBytes.slice(0, partialBytes));
    }

    return new Blob(parts, { type: 'audio/wav' });
  }

  return { exportWAV };
})();

// === UI ===
const UI = (() => {
  const els = {};

  function init() {
    // Cache DOM elements
    els.grid = document.getElementById('sequencer-grid');
    els.noteLabels = document.getElementById('note-labels');
    els.stepNumbers = document.getElementById('step-numbers');
    els.playhead = document.getElementById('playhead');
    els.waveType = document.getElementById('wave-type');
    els.channelVolume = document.getElementById('channel-volume');
    els.volumeDisplay = document.getElementById('volume-display');
    els.btnMute = document.getElementById('btn-mute');
    els.btnSolo = document.getElementById('btn-solo');
    els.btnPlay = document.getElementById('btn-play');
    els.btnStop = document.getElementById('btn-stop');
    els.bpmSlider = document.getElementById('bpm-slider');
    els.bpmInput = document.getElementById('bpm-input');
    els.btnLoop = document.getElementById('btn-loop');
    els.genScale = document.getElementById('gen-scale');
    els.genRoot = document.getElementById('gen-root');
    els.genDensity = document.getElementById('gen-density');
    els.densityDisplay = document.getElementById('density-display');
    els.btnStyleGen = document.getElementById('btn-style-gen');
    els.btnGenerate = document.getElementById('btn-generate');
    els.btnClear = document.getElementById('btn-clear');
    els.btnExport = document.getElementById('btn-export');
    els.btnBitMode = document.getElementById('btn-bitmode');

    buildNoteLabels();
    buildStepNumbers();
    buildGrid();
    bindEvents();
    setChannelTheme(0);
    syncChannelControls();
    fitGridToScreen();

    // Sync note-labels vertical scroll with grid scroll
    const gridScroll = els.grid.parentElement;
    gridScroll.addEventListener('scroll', () => {
      els.noteLabels.style.transform = `translateY(-${gridScroll.scrollTop}px)`;
    });

    window.addEventListener('resize', fitGridToScreen);
  }

  function fitGridToScreen() {
    const wrapper = document.querySelector('.sequencer-wrapper');
    const labelsWidth = els.noteLabels.offsetWidth + 2;
    const availableHeight = wrapper.clientHeight;
    // Size cells to fit all rows vertically; grid scrolls horizontally if needed
    const cellSize = Math.max(14, Math.floor(availableHeight / (Config.ROWS + 1)));
    document.documentElement.style.setProperty('--cell-size', cellSize + 'px');
  }

  function noteToName(midi) {
    const name = Config.NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    return name + octave;
  }

  function buildNoteLabels() {
    els.noteLabels.innerHTML = '';
    // Top row = highest note
    for (let row = 0; row < Config.ROWS; row++) {
      const midi = Config.MAX_NOTE - row;
      const name = noteToName(midi);
      const div = document.createElement('div');
      div.className = 'note-label';
      if (name.includes('#')) div.classList.add('sharp');
      if (midi % 12 === 0) div.classList.add('c-note');
      div.textContent = name;
      els.noteLabels.appendChild(div);
    }
  }

  function buildStepNumbers() {
    els.stepNumbers.innerHTML = '';
    for (let step = 0; step < Config.STEPS; step++) {
      const div = document.createElement('div');
      div.className = 'step-number';
      if (step % 4 === 0) div.classList.add('beat');
      div.textContent = step + 1;
      els.stepNumbers.appendChild(div);
    }
  }

  function buildGrid() {
    els.grid.innerHTML = '';
    for (let row = 0; row < Config.ROWS; row++) {
      for (let step = 0; step < Config.STEPS; step++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = row;
        cell.dataset.step = step;
        if (step % 4 === 0) cell.classList.add('beat-line');
        els.grid.appendChild(cell);
      }
    }
    renderGrid();
  }

  function renderGrid() {
    const cells = els.grid.querySelectorAll('.cell');
    const ch = State.activeChannel;
    cells.forEach(cell => {
      const row = parseInt(cell.dataset.row);
      const step = parseInt(cell.dataset.step);
      const midi = Config.MAX_NOTE - row;
      const isActive = State.patterns[ch][step].has(midi);
      cell.classList.toggle('active', isActive);
    });
  }

  function toggleCell(row, step) {
    const midi = Config.MAX_NOTE - row;
    const ch = State.activeChannel;
    const notes = State.patterns[ch][step];
    if (notes.has(midi)) {
      notes.delete(midi);
    } else {
      notes.add(midi);
    }
    renderGrid();
  }

  function setChannelTheme(idx) {
    document.body.className = `channel-${idx}`;
  }

  function syncWaveOptions() {
    const allowed = Audio.getAllowedWaves(State.bitMode);
    const options = els.waveType.querySelectorAll('option');
    options.forEach(opt => {
      opt.disabled = !allowed.includes(opt.value);
    });
    // If current channel's wave is now disallowed, clamp it
    const ch = State.channels[State.activeChannel];
    const clamped = Audio.clampWaveType(ch.waveType, State.bitMode);
    if (clamped !== ch.waveType) {
      ch.waveType = clamped;
    }
    els.waveType.value = ch.waveType;
  }

  function syncChannelControls() {
    const ch = State.channels[State.activeChannel];
    els.waveType.value = ch.waveType;
    els.channelVolume.value = Math.round(ch.volume * 100);
    els.volumeDisplay.textContent = Math.round(ch.volume * 100);
    els.btnMute.classList.toggle('active', ch.muted);
    els.btnSolo.classList.toggle('active', ch.solo);
    syncWaveOptions();

    // Update tabs
    document.querySelectorAll('.channel-tab').forEach((tab, i) => {
      tab.classList.toggle('active', i === State.activeChannel);
    });
  }

  function syncGeneratorControls() {
    els.genScale.value = State.generate.scale;
    els.genRoot.value = State.generate.rootNote;
    els.genDensity.value = State.generate.density;
    els.densityDisplay.textContent = State.generate.density;
    els.bpmSlider.value = State.bpm;
    els.bpmInput.value = State.bpm;
    syncChannelControls();
  }

  function updatePlayhead(step) {
    State.currentStep = step;
    const cellSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-size'));
    els.playhead.style.left = step * cellSize + 'px';
  }

  function onPlayStateChange() {
    els.playhead.classList.toggle('visible', State.playing);
    els.btnPlay.classList.toggle('playing', State.playing);
    if (!State.playing) {
      els.playhead.style.left = '0px';
    }
  }

  function bindEvents() {
    // Grid click with drag support
    let isMouseDown = false;
    let paintMode = null; // true = adding, false = removing

    els.grid.addEventListener('mousedown', e => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      isMouseDown = true;
      const row = parseInt(cell.dataset.row);
      const step = parseInt(cell.dataset.step);
      const midi = Config.MAX_NOTE - row;
      // Determine paint mode based on initial cell state
      paintMode = !State.patterns[State.activeChannel][step].has(midi);
      toggleCell(row, step);
      Audio.init(); // ensure audio context on gesture
    });

    els.grid.addEventListener('mouseover', e => {
      if (!isMouseDown) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const row = parseInt(cell.dataset.row);
      const step = parseInt(cell.dataset.step);
      const midi = Config.MAX_NOTE - row;
      const notes = State.patterns[State.activeChannel][step];
      const isActive = notes.has(midi);
      if (paintMode && !isActive) {
        notes.add(midi);
        renderGrid();
      } else if (!paintMode && isActive) {
        notes.delete(midi);
        renderGrid();
      }
    });

    document.addEventListener('mouseup', () => {
      isMouseDown = false;
      paintMode = null;
    });

    // Channel tabs
    document.querySelectorAll('.channel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        State.activeChannel = parseInt(tab.dataset.channel);
        setChannelTheme(State.activeChannel);
        syncChannelControls();
        renderGrid();
      });
    });

    // Channel controls
    els.waveType.addEventListener('change', () => {
      State.channels[State.activeChannel].waveType = els.waveType.value;
    });

    els.channelVolume.addEventListener('input', () => {
      const val = parseInt(els.channelVolume.value);
      State.channels[State.activeChannel].volume = val / 100;
      els.volumeDisplay.textContent = val;
    });

    els.btnMute.addEventListener('click', () => {
      const ch = State.channels[State.activeChannel];
      ch.muted = !ch.muted;
      els.btnMute.classList.toggle('active', ch.muted);
    });

    els.btnSolo.addEventListener('click', () => {
      const ch = State.channels[State.activeChannel];
      ch.solo = !ch.solo;
      els.btnSolo.classList.toggle('active', ch.solo);
    });

    // Transport
    els.btnPlay.addEventListener('click', () => {
      if (State.playing) {
        Audio.stop();
      } else {
        Audio.play();
      }
    });

    els.btnStop.addEventListener('click', () => {
      Audio.stop();
    });

    function syncBpmFromSlider() {
      State.bpm = parseInt(els.bpmSlider.value) || 0;
      if (els.bpmInput) els.bpmInput.value = State.bpm;
    }
    function syncBpmFromInput() {
      let val = parseInt(els.bpmInput.value) || 0;
      val = Math.max(0, Math.min(240, val));
      State.bpm = val;
      els.bpmSlider.value = val;
      els.bpmInput.value = val;
    }
    els.bpmSlider.addEventListener('input', syncBpmFromSlider);
    els.bpmSlider.addEventListener('change', syncBpmFromSlider);
    if (els.bpmInput) {
      els.bpmInput.addEventListener('input', syncBpmFromInput);
      els.bpmInput.addEventListener('change', syncBpmFromInput);
    }

    els.btnLoop.addEventListener('click', () => {
      State.looping = !State.looping;
      els.btnLoop.classList.toggle('active', State.looping);
    });

    // Bit mode toggle
    els.btnBitMode.addEventListener('click', () => {
      Audio.init();
      // Cycle 8 → 16 → 32 → 8
      State.bitMode = State.bitMode === 8 ? 16 : State.bitMode === 16 ? 32 : 8;
      Audio.setBitMode(State.bitMode);
      els.btnBitMode.textContent = State.bitMode + '-BIT';
      els.btnBitMode.classList.remove('active');
      els.btnBitMode.classList.remove('mode-16');
      els.btnBitMode.classList.remove('mode-32');
      if (State.bitMode === 8) els.btnBitMode.classList.add('active');
      else if (State.bitMode === 16) els.btnBitMode.classList.add('mode-16');
      else els.btnBitMode.classList.add('mode-32');
      syncWaveOptions();
    });

    // Preset chips
    document.querySelectorAll('.preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        Audio.init();
        Generator.applyPreset(chip.dataset.preset);
        syncGeneratorControls();
        Generator.generateAll();
      });
    });

    // Generator
    els.genScale.addEventListener('change', () => {
      State.generate.scale = els.genScale.value;
    });

    els.genRoot.addEventListener('change', () => {
      State.generate.rootNote = parseInt(els.genRoot.value);
    });

    els.genDensity.addEventListener('input', () => {
      State.generate.density = parseInt(els.genDensity.value);
      els.densityDisplay.textContent = State.generate.density;
    });

    // GENERATE: uses the selected style preset
    if (els.btnStyleGen) {
      els.btnStyleGen.addEventListener('click', () => {
        console.log('GENERATE clicked, style:', State.activePreset);
        Audio.init();
        Generator.applyPreset(State.activePreset);
        Generator.generateAll();
        syncGeneratorControls();
      });
    } else {
      console.warn('btn-style-gen not found in DOM — using cached HTML?');
    }

    // RANDOMIZE: fully random scale, BPM, waves, styles
    els.btnGenerate.addEventListener('click', () => {
      Audio.init();
      Generator.generateRandom();
      syncGeneratorControls();
    });

    els.btnClear.addEventListener('click', () => {
      Generator.clearAll();
    });

    // Export
    els.exportDuration = document.getElementById('export-duration');
    els.btnExport.addEventListener('click', () => {
      try {
        Audio.init();
        const raw = els.exportDuration ? els.exportDuration.value.trim() : '';
        const durVal = parseFloat(raw);
        const customDur = (Number.isFinite(durVal) && durVal > 0) ? Math.min(durVal, 1000) : 0;
        console.log('Export clicked, customDur:', customDur, 'BPM:', State.bpm);
        Exporter.exportWAV(customDur);
      } catch (e) {
        console.error('Export error:', e);
        alert('Export failed: ' + e.message);
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (State.playing) Audio.stop();
        else Audio.play();
      }
    });
  }

  return { init, renderGrid, updatePlayhead, onPlayStateChange };
})();

// === Bootstrap ===
document.addEventListener('DOMContentLoaded', UI.init);
