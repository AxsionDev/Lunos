# Voice input

Hold a key (or the mic button in the desktop app), say your prompt, and let go. The text appears in
the prompt for you to edit; nothing is sent until you send it.

Speech is turned into text **on your computer** by [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
Lunos has no cloud speech option.

- The audio is kept in memory only. It is never written to disk, sent to the Lunos server, logged,
  or included in telemetry, and it is dropped as soon as the transcript is ready (or when you press
  Esc).
- Recording and transcription make no network requests. The only download is the speech model, once,
  after you agree to it.

## Using it

| Where       | How                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| TUI         | `ctrl+space` (keybind `prompt.voice`): hold it to talk and release, or press once to start and again to stop. Esc cancels. |
| Desktop app | The mic button next to Send: hold it, or click to start and click again to stop. Esc cancels.                              |
| Web app     | No mic button: the web app's server may run on another machine, and the audio must not leave yours.                        |

While recording, a level meter and a timer show next to the prompt.

Most terminals don't report key releases, so the TUI tells a hold from a tap by the key's
auto-repeat: if the key keeps repeating you're holding it, and when it stops you've let go. With key
repeat turned off in your system settings, use press-to-start, press-to-stop.

**macOS:** `ctrl+space` switches the input source when you have more than one keyboard layout. Rebind
it in `tui.json`, for example `"keybinds": { "prompt.voice": "ctrl+alt+v" }`.

## Setup

### whisper.cpp

Lunos looks for `whisper-cli` in `<data>/voice/bin` first (for administrators and offline installs),
then on your `PATH`. There is deliberately no setting for its path: a repository's config must not be
able to choose a program for a key press to run.

| OS      | Install                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `brew install whisper-cpp` (uses Metal on Apple Silicon)                                                                                                                                     |
| Windows | `whisper-bin-x64.zip` (CPU) or `whisper-cublas-*-bin-x64.zip` (CUDA) from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases); put `whisper-cli.exe` on your `PATH` |
| Linux   | Your distribution's `whisper-cpp` package, or build it ([with CUDA](https://github.com/ggml-org/whisper.cpp#nvidia-gpu-support) if you have an NVIDIA GPU)                                   |

Lunos passes the audio on stdin and reads the text from stdout (`-f - -otxt -of -`), which needs a recent whisper.cpp; 1.9.5 is tested.

### The microphone (TUI only)

The terminal has no microphone access of its own, so the TUI records through a system recorder that
writes raw audio to its output, which Lunos reads into memory:

| OS      | Recorder                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| macOS   | `ffmpeg` (`brew install ffmpeg`). Allow your terminal app in System Settings › Privacy & Security › Microphone.                      |
| Windows | `ffmpeg` (`winget install ffmpeg`); the first microphone it lists. Allow desktop apps in Settings › Privacy & security › Microphone. |
| Linux   | `parecord` (PulseAudio, or PipeWire through pipewire-pulse), else `pw-record`, `arecord` or `ffmpeg`.                                |

The desktop app records with the system's own audio APIs and asks for the microphone the first time.

### The speech model

The first time you use voice input, Lunos asks before downloading the model. Models come from
whisper.cpp's own repository on Hugging Face,
[`ggerganov/whisper.cpp`](https://huggingface.co/ggerganov/whisper.cpp), at a pinned revision, and
each download is checked against its pinned size and SHA-256 before it is kept:

| `voice.model`    | File              | Size   | SHA-256                                                            |
| ---------------- | ----------------- | ------ | ------------------------------------------------------------------ |
| `tiny`           | `ggml-tiny.bin`   | 78 MB  | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| `base` (default) | `ggml-base.bin`   | 148 MB | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| `small`          | `ggml-small.bin`  | 488 MB | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| `medium`         | `ggml-medium.bin` | 1.5 GB | `6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208` |

They're the multilingual models: the language is detected (Bulgarian, German, French and the other
EU languages included). For languages close to each other, set `voice.language` (for example `"bg"`)
if detection picks the wrong one; `small` is noticeably better than `base` outside English.

**Offline and air-gapped machines** (`LUNOS_OFFLINE`): the download is blocked. Copy the model file
into `<data>/voice/models/` (on macOS and Linux `~/.local/share/opencode/voice/models/`, on Windows
`%USERPROFILE%\.local\share\opencode\voice\models\`). Lunos checks it against the same SHA-256 before
loading it, and ignores a file that doesn't match.

## Configuration

```jsonc
{
  "voice": {
    "enabled": true, // false hides the key and the mic button
    "model": "base", // tiny | base | small | medium
    "language": "auto", // or a whisper language code: en, bg, de, fr, ...
    "auto_send": 0, // seconds without typing before the transcript is sent; 0 = never
  },
}
```

### For organisations

Turn voice input off for everyone with managed config (or the organisation policy), and lock it:

```json
{ "voice": { "enabled": false }, "$locked": ["voice"] }
```

The TUI key and the desktop mic button then disappear. Voice input is always local-only: there is no
cloud speech option to forbid.
