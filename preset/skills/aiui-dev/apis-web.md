# AIUI Web Networking and Encoding API Reference

This file documents the currently verified browser-style networking and text decoding APIs available to AIUI app code.

- Common scope, entry points, and authoring rules live in [apis.md](./apis.md).
- Treat this file as the implementation-aligned reference for streamed HTTPS consumption and incremental text decoding.

## `fetch(url, options?)`

### Return behavior

- `fetch(url, options?)` returns a `Promise<Response>`.

### Behavior notes

- Prefer `fetch` when you want promise-based request flow or streamed body consumption through `response.body`.
- If you only care about the final buffered result, `response.text()`, `response.json()`, and `response.arrayBuffer()` remain valid choices.

## `Headers`

### Constructor

- `new Headers(init?)`

### Confirmed behavior

- Current compatibility checks explicitly cover case-insensitive key lookup.
- Repeated header values are merged and returned from `get(name)` as a comma-separated string.
- Verified methods in current examples include `has(name)` and `get(name)`.

### Example

```javascript
const headers = new Headers([
  ['X-Test', 'one'],
  ['x-test', 'two'],
]);

console.log(headers.has('x-test')); // true
console.log(headers.get('X-Test')); // "one, two"
```

## `Response`

### Common properties

- `ok`
- `status`
- `statusText`
- `url`
- `body`
- `bodyUsed`

### Common methods

- `clone()`
- `text()`
- `json()`
- `arrayBuffer()`

### Behavior notes

- `body` is exposed as a `ReadableStream`.
- Once the body is locked by `getReader()`, convenience readers such as `text()` and `json()` no longer consume that same body.
- `bodyUsed` becomes `true` after the body has been consumed or locked to a reader.
- `clone()` allows the original response and the cloned response to be consumed independently.

## `ReadableStream`

### Confirmed usage

- The current documented usage focuses on `response.body.getReader()` for streamed HTTPS responses.
- Use `reader.read()` to pull incremental chunks.
- If `reader.releaseLock` exists and you no longer need the reader, release the lock before reusing the stream object elsewhere.

### Example

```javascript
const response = await fetch('https://example.com/stream');
const reader = response.body.getReader();

while (true) {
  const { value, done } = await reader.read();
  if (done) {
    break;
  }

  console.log('chunk bytes:', value.byteLength);
}
```

## `TextDecoder`

### Constructor

- `new TextDecoder(label?, options?)`

### Common properties

- `encoding`
- `fatal`
- `ignoreBOM`

### Methods

- `decode(input?, options?)`

### Behavior notes

- `decode(input, { stream: true })` keeps the decoder state across chunk boundaries.
- Call `decode()` once more with no input after the last chunk to flush any buffered trailing bytes.
- For streamed UTF-8 text, this is the preferred pattern because multibyte characters may span multiple chunks.

### Example

```javascript
const response = await fetch('https://example.com/stream');
const reader = response.body.getReader();
const decoder = new TextDecoder('utf-8');

let text = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) {
    break;
  }

  text += decoder.decode(value, { stream: true });
}

text += decoder.decode();
console.log(text);
```

## Authoring Rules For Agents

- Prefer `fetch` over `wx.request` when you need `async/await` flow or streamed body consumption.
- Prefer `wx.request` when you need Mini Program-style task callbacks or `RequestTask` control.
- For streamed text, pair `response.body.getReader()` with `TextDecoder.decode(value, { stream: true })` and a final empty `decode()` flush.
- Do not mix `getReader()` with `text()`, `json()`, or `arrayBuffer()` on the same body unless you deliberately use `response.clone()`.
