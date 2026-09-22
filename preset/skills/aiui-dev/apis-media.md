# AIUI Media API Reference

This file documents the verified media playback APIs available to AIUI app code.

- Common scope, entry points, and authoring rules live in [apis.md](./apis.md).
- Keep examples aligned with the current local-file-focused implementation.

## `AudioPlayer`

### Constructor

- `new AudioPlayer(options?)`

### Common properties

- `src`
- `autoplay`
- `loop`
- `volume`
- `currentTime`
- `paused`

### Common methods

- `play()`
- `pause()`
- `stop()`
- `seek(position)`
- `destroy()`
- `append(buffer)`
- `finish()`

### Behavior notes

- `AudioPlayer` is the general-purpose playback API for full audio files and streaming audio data.
- For file playback, set `player.src` to either a relative local path or a project-root absolute path such as `/assets/intro.ogg`.
- Local path handling now explicitly covers leading-slash asset paths under the app package.
- Network URLs are supported for `src`, but local packaged assets remain the preferred choice for bundled media.
- Streaming playback is enabled through the constructor `options` object and currently documented for `format: 'pcm'` and `format: 'ogg_opus'`.
- Use `append()` to push streaming chunks and `finish()` when the stream ends.

### Example

```javascript
import { AudioPlayer } from 'audio';

const player = new AudioPlayer();
player.src = '/assets/intro.ogg';
player.loop = true;
player.play();
```

## `Sound`

### Constructor

- `new Sound(src)`

### Properties

- `volume`

### Methods

- `play()`
- `stop()`
- `destroy()`

### Behavior notes

- `src` must be a non-empty local file path.
- Remote URLs such as `http://` and `https://` are rejected.
- The source is bound during construction so the instance is ready for replay-oriented playback.
- Local sound effect paths can be relative or project-root absolute, for example `/assets/click.wav`.
- `volume` is a read/write number.
- `play()` stops any current playback on the instance and starts again from the beginning.
- `Sound` supports local files only.
- `Sound` does not expose `src` mutation, seeking, streaming, or event callbacks.

### Error behavior

- After `destroy()`, later method calls throw.
