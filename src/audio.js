// Spoken lap callouts and a drift-angle tone, so the driver never has to read the phone.

function speakableTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const whole = Math.floor(rest);
  const tenths = Math.floor((rest - whole) * 10);
  const restText = minutes ? String(whole).padStart(2, "0") : String(whole);
  return minutes ? `${minutes} ${restText} point ${tenths}` : `${restText} point ${tenths}`;
}

export class Announcer {
  constructor() {
    this.enabled = true;
  }

  available() {
    return "speechSynthesis" in window;
  }

  say(text) {
    if (!this.enabled || !this.available()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  }

  announceLap({ number, time, isBest, deltaToBest }) {
    let text = `Lap ${number}. ${speakableTime(time)}.`;
    if (isBest && deltaToBest != null) {
      text += " Best lap.";
    } else if (deltaToBest != null) {
      text += ` Plus ${Math.abs(deltaToBest).toFixed(1)}.`;
    }
    this.say(text);
  }
}

export class DriftTone {
  constructor() {
    this.enabled = false;
    this.context = null;
    this.oscillator = null;
    this.gain = null;
  }

  // Must be called from a user gesture so mobile browsers allow audio.
  unlock() {
    if (this.context || !this.enabled) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    this.oscillator = this.context.createOscillator();
    this.gain = this.context.createGain();
    this.oscillator.type = "triangle";
    this.gain.gain.value = 0;
    this.oscillator.connect(this.gain).connect(this.context.destination);
    this.oscillator.start();
  }

  update(angleDegrees, drifting) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    const angle = Math.abs(angleDegrees ?? 0);
    this.oscillator.frequency.setTargetAtTime(220 + angle * 14, now, 0.05);
    this.gain.gain.setTargetAtTime(drifting ? 0.12 : 0, now, 0.05);
  }

  stop() {
    if (!this.context) return;
    this.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
  }
}
