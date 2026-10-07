/**
 * ============================================================
 * SoundSystem.js —— 程序化音效（Web Audio API，零音频文件）
 * ============================================================
 * 首次用户点击 / 按键后 unlock，绕过浏览器自动播放限制。
 * 优先播放 assets/audio/sfx/*.mp3；缺失或加载失败时回退程序化合成。
 * 对外：FK.SoundSystem
 * ============================================================
 */
window.FK = window.FK || {};

(function () {
  'use strict';

  const STORAGE_KEY = 'fk.audio.muted';
  const SFX_BASE = 'assets/audio/sfx/';
  /** play(name) → 文件名（move 用 jump.mp3） */
  const SFX_FILES = {
    throw: 'throw.mp3',
    explode_cherry: 'explode_cherry.mp3',
    explode_watermelon: 'explode_watermelon.mp3',
    splash: 'splash.mp3',
    crate_land: 'crate_land.mp3',
    move: 'jump.mp3',
    turn_switch: 'turn_switch.mp3',
    click: 'click.mp3'
  };

  function cfg() {
    return (FK.Config && FK.Config.AUDIO) ? FK.Config.AUDIO : {
      enabled: true, volume: 0.5, maxSameSfxMs: 100, sounds: {}
    };
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  const api = {
    ctx: null,
    unlocked: false,
    muted: false,
    lastPlay: {},
    active: {},
    noiseBuf: null,
    clips: {},
    fileFailed: {},

    init: function () {
      this.muted = this.readMuted();
      this.bindGameplay();
      if (this.windowHooked) { return this; }
      this.windowHooked = true;
      const self = this;
      function onFirst() { self.unlock(); }
      if (typeof window !== 'undefined') {
        window.addEventListener('pointerdown', onFirst, true);
        window.addEventListener('keydown', onFirst, true);
        window.addEventListener('touchstart', onFirst, true);
      }
      this.preloadFiles();
      return this;
    },

    /** 直接挂 EventBus（场景 EventBus.clear 后由 init 再绑一次） */
    bindGameplay: function () {
      const bus = FK.EventBus;
      if (!bus || typeof bus.on !== 'function') { return this; }
      const E = FK.EVENTS || {};
      const self = this;
      if (!this._sfxHandlers) {
        this._sfxHandlers = {
          drowned: function () { self.play('splash'); },
          died: function (p) {
            if (p && (p.reason === 'drowned' || p.reason === 'water')) { self.play('splash'); }
          },
          removed: function (p) {
            if (p && (p.reason === 'water' || p.hitType === 'water')) { self.play('splash'); }
          },
          landed: function (p) {
            if (p && p.hitType === 'water') { self.play('splash'); }
          },
          move: function () { self.play('move'); }
        };
      }
      const h = this._sfxHandlers;
      function hook(ev, fn) {
        if (!ev) { return; }
        if (typeof bus.off === 'function') { bus.off(ev, fn); }
        bus.on(ev, fn);
      }
      hook(E.UNIT_DROWNED || 'unit:drowned', h.drowned);
      hook(E.UNIT_DIED || 'unit:died', h.died);
      hook(E.PROJECTILE_REMOVED || 'projectile:removed', h.removed);
      hook(E.PROJECTILE_LANDED || 'projectile:landed', h.landed);
      hook(E.MOVE_END || 'move:end', h.move);
      return this;
    },

    readMuted: function () {
      try {
        if (typeof localStorage !== 'undefined') {
          return localStorage.getItem(STORAGE_KEY) === '1';
        }
      } catch (e) { /* file:// 隐私模式 */ }
      return false;
    },

    writeMuted: function (v) {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
        }
      } catch (e) { /* ignore */ }
    },

    isMuted: function () { return !!this.muted; },

    setMuted: function (v) {
      const next = !!v;
      this.muted = next;
      this.writeMuted(next);
      if (next) { this.stopAll(); }
      if (FK.EventBus && FK.EVENTS) {
        FK.EventBus.emit(next ? FK.EVENTS.AUDIO_MUTED : FK.EVENTS.AUDIO_UNMUTED, { muted: next });
      }
      if (!next) { this.unlock(); }
      return this;
    },

    unlock: function () {
      if (this.muted) { return this; }
      const AC = (typeof window !== 'undefined')
        ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AC) { return this; }
      if (!this.ctx) {
        try { this.ctx = new AC(); } catch (e) { return this; }
      }
      if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
        this.ctx.resume();
      }
      this.unlocked = true;
      this.preloadFiles();
      return this;
    },

    preloadFiles: function () {
      if (typeof Audio === 'undefined') { return this; }
      const names = Object.keys(SFX_FILES);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (this.clips[name] || this.fileFailed[name]) { continue; }
        const a = new Audio();
        a.preload = 'auto';
        a.src = SFX_BASE + SFX_FILES[name];
        const self = this;
        a.onerror = function () { self.fileFailed[name] = true; };
        this.clips[name] = a;
      }
      return this;
    },

    playFile: function (name, vol) {
      if (this.fileFailed[name]) { return false; }
      const el = this.clips[name];
      if (!el) { return false; }
      try {
        el.pause();
        if (typeof el.currentTime === 'number') { el.currentTime = 0; }
        el.volume = vol;
        const p = el.play();
        if (p && typeof p.catch === 'function') {
          const self = this;
          p.catch(function () { self.fileFailed[name] = true; });
        }
        return true;
      } catch (e) {
        this.fileFailed[name] = true;
        return false;
      }
    },

    play: function (name) {
      const a = cfg();
      if (!a.enabled || this.muted) { return this; }
      const sounds = a.sounds || {};
      const spec = sounds[name];
      if (spec && spec.enabled === false) { return this; }

      const gap = (typeof a.maxSameSfxMs === 'number') ? a.maxSameSfxMs : 100;
      const t = nowMs();
      if (this.lastPlay[name] && (t - this.lastPlay[name]) < gap) { return this; }
      this.lastPlay[name] = t;

      this.unlock();
      const vol = Math.max(0, Math.min(1, typeof a.volume === 'number' ? a.volume : 0.5));
      if (this.playFile(name, vol)) { return this; }

      if (!this.ctx || !this.unlocked) { return this; }
      this.stopName(name);
      const fn = PLAYERS[name];
      if (typeof fn === 'function') { fn(this, vol); }
      return this;
    },

    master: function (vol) {
      const g = this.ctx.createGain();
      g.gain.value = vol;
      g.connect(this.ctx.destination);
      return g;
    },

    noise: function () {
      if (!this.noiseBuf) {
        const sr = this.ctx.sampleRate;
        const n = Math.floor(sr * 0.5);
        const buf = this.ctx.createBuffer(1, n, sr);
        const data = buf.getChannelData(0);
        for (let i = 0; i < n; i++) { data[i] = Math.random() * 2 - 1; }
        this.noiseBuf = buf;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      return src;
    },

    track: function (name, nodes, durMs) {
      this.active[name] = nodes;
      const self = this;
      setTimeout(function () {
        self.stopNodes(nodes);
        if (self.active[name] === nodes) { self.active[name] = null; }
      }, durMs + 30);
    },

    stopName: function (name) {
      this.stopNodes(this.active[name]);
      this.active[name] = null;
      const el = this.clips[name];
      if (el && typeof el.pause === 'function') {
        try { el.pause(); } catch (e) { /* ignore */ }
      }
    },

    stopAll: function () {
      const keys = Object.keys(this.active);
      for (let i = 0; i < keys.length; i++) { this.stopName(keys[i]); }
      const clipNames = Object.keys(this.clips);
      for (let j = 0; j < clipNames.length; j++) {
        const el = this.clips[clipNames[j]];
        if (el && typeof el.pause === 'function') {
          try { el.pause(); } catch (e) { /* ignore */ }
        }
      }
    },

    stopNodes: function (nodes) {
      if (!nodes) { return; }
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        try {
          if (n && typeof n.stop === 'function') { n.stop(); }
        } catch (e) { /* already stopped */ }
        try {
          if (n && typeof n.disconnect === 'function') { n.disconnect(); }
        } catch (e2) { /* ignore */ }
      }
    }
  };

  function balloonPop(sys, vol, name, dur, noisePeak) {
    const ctx = sys.ctx;
    const t0 = ctx.currentTime;
    const out = sys.master(vol);

    const nz = sys.noise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 1.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(Math.max(0.001, noisePeak), t0);
    ng.gain.exponentialRampToValueAtTime(Math.max(0.001, noisePeak * 0.08), t0 + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    nz.connect(bp);
    bp.connect(ng);
    ng.connect(out);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 100;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.4, t0);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    osc.connect(og);
    og.connect(out);

    nz.start(t0);
    osc.start(t0);
    osc.stop(t0 + 0.055);
    nz.stop(t0 + dur + 0.02);
    sys.track(name, [nz, osc, ng, og, bp, out], Math.round(dur * 1000));
  }

  function envGain(ctx, peak, start, dur, attack, curve) {
    const g = ctx.createGain();
    const a = Math.min(attack || 0.008, dur * 0.3);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + a);
    if (curve === 'slow') {
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    }
    return g;
  }

  const PLAYERS = {
    throw: function (sys, vol) {
      const ctx = sys.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.12;
      const out = sys.master(vol);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(800, t0);
      osc.frequency.exponentialRampToValueAtTime(200, t0 + dur);
      const og = envGain(ctx, 0.18, t0, dur, 0.005);
      osc.connect(og); og.connect(out);
      const nz = sys.noise();
      const ng = envGain(ctx, 0.22, t0, dur, 0.004);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1800, t0);
      bp.frequency.exponentialRampToValueAtTime(400, t0 + dur);
      nz.connect(bp); bp.connect(ng); ng.connect(out);
      osc.start(t0); nz.start(t0);
      osc.stop(t0 + dur + 0.02); nz.stop(t0 + dur + 0.02);
      sys.track('throw', [osc, nz, og, ng, bp, out], 120);
    },

    explode_cherry: function (sys, vol) {
      balloonPop(sys, vol, 'explode_cherry', 0.18, 0.55);
    },

    explode_watermelon: function (sys, vol) {
      balloonPop(sys, vol, 'explode_watermelon', 0.25, 0.72);
    },

    splash: function (sys, vol) {
      const ctx = sys.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.2;
      const out = sys.master(vol);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, t0);
      osc.frequency.exponentialRampToValueAtTime(300, t0 + dur);
      const og = envGain(ctx, 0.2, t0, dur, 0.005);
      osc.connect(og); og.connect(out);
      const nz = sys.noise();
      const ng = envGain(ctx, 0.4, t0, dur, 0.004);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1400, t0);
      bp.frequency.exponentialRampToValueAtTime(350, t0 + dur);
      nz.connect(bp); bp.connect(ng); ng.connect(out);
      osc.start(t0); nz.start(t0);
      osc.stop(t0 + dur + 0.02); nz.stop(t0 + dur + 0.02);
      sys.track('splash', [osc, nz, og, ng, bp, out], 200);
    },

    crate_land: function (sys, vol) {
      const ctx = sys.ctx;
      const t0 = ctx.currentTime;
      const out = sys.master(vol);
      const nodes = [out];
      function hit(at) {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(200, at);
        osc.frequency.exponentialRampToValueAtTime(90, at + 0.06);
        const g = envGain(ctx, 0.22, at, 0.07, 0.002);
        osc.connect(g); g.connect(out);
        osc.start(at); osc.stop(at + 0.08);
        nodes.push(osc, g);
      }
      hit(t0);
      hit(t0 + 0.07);
      sys.track('crate_land', nodes, 150);
    },

    move: function (sys, vol) {
      const ctx = sys.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.15;
      const out = sys.master(vol);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(400, t0);
      osc.frequency.exponentialRampToValueAtTime(700, t0 + dur);
      const g = envGain(ctx, 0.55, t0, dur, 0.008);
      osc.connect(g); g.connect(out);
      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(400, t0);
      osc2.frequency.exponentialRampToValueAtTime(700, t0 + dur);
      const g2 = envGain(ctx, 0.22, t0, dur, 0.008);
      osc2.connect(g2); g2.connect(out);
      osc.start(t0); osc2.start(t0);
      osc.stop(t0 + dur + 0.02); osc2.stop(t0 + dur + 0.02);
      sys.track('move', [osc, osc2, g, g2, out], 150);
    },

    turn_switch: function (sys, vol) {
      const ctx = sys.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.2;
      const out = sys.master(vol);
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      a.type = 'sine'; b.type = 'sine';
      a.frequency.value = 500; b.frequency.value = 700;
      const ga = envGain(ctx, 0.16, t0, dur, 0.008);
      const gb = envGain(ctx, 0.14, t0 + 0.04, dur - 0.04, 0.008);
      a.connect(ga); ga.connect(out);
      b.connect(gb); gb.connect(out);
      a.start(t0); b.start(t0 + 0.04);
      a.stop(t0 + dur + 0.02); b.stop(t0 + dur + 0.02);
      sys.track('turn_switch', [a, b, ga, gb, out], 200);
    },

    click: function (sys, vol) {
      const ctx = sys.ctx;
      const t0 = ctx.currentTime;
      const dur = 0.05;
      const out = sys.master(vol);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1000;
      const g = envGain(ctx, 0.2, t0, dur, 0.002);
      osc.connect(g); g.connect(out);
      osc.start(t0); osc.stop(t0 + dur + 0.01);
      sys.track('click', [osc, g, out], 50);
    }
  };

  FK.SoundSystem = api;
})();
