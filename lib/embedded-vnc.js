import net from "node:net";
import os from "node:os";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 500;
const SERVER_VERSION = Buffer.from("RFB 003.008\n", "ascii");

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function writeU16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value, 0);
  return out;
}

function writeU32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

function writeI32(value) {
  const out = Buffer.alloc(4);
  out.writeInt32BE(value, 0);
  return out;
}

function pixelOffset(width, x, y) {
  return ((y * width) + x) * 4;
}

function putPixel(frame, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = pixelOffset(width, x, y);
  frame[offset] = color.b;
  frame[offset + 1] = color.g;
  frame[offset + 2] = color.r;
  frame[offset + 3] = 0;
}

function fillRect(frame, width, height, x, y, rectWidth, rectHeight, color) {
  const x0 = clamp(Math.floor(x), 0, width);
  const y0 = clamp(Math.floor(y), 0, height);
  const x1 = clamp(Math.ceil(x + rectWidth), 0, width);
  const y1 = clamp(Math.ceil(y + rectHeight), 0, height);
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) putPixel(frame, width, height, xx, yy, color);
  }
}

function drawChar(frame, width, height, x, y, char, scale, color) {
  const glyph = FONT[char] || FONT[" "];
  for (let row = 0; row < glyph.length; row += 1) {
    for (let col = 0; col < glyph[row].length; col += 1) {
      if (glyph[row][col] !== "1") continue;
      fillRect(frame, width, height, x + col * scale, y + row * scale, scale, scale, color);
    }
  }
}

function drawText(frame, width, height, x, y, text, scale, color) {
  let cursor = x;
  for (const char of String(text || "").toUpperCase()) {
    drawChar(frame, width, height, cursor, y, char, scale, color);
    cursor += 6 * scale;
  }
}

function drawDesktopFrame(state) {
  const { width, height } = state;
  const frame = Buffer.alloc(width * height * 4);
  const bgTop = { r: 18, g: 24, b: 38 };
  const bgBottom = { r: 6, g: 10, b: 18 };
  for (let y = 0; y < height; y += 1) {
    const ratio = y / Math.max(1, height - 1);
    const color = {
      r: Math.round(bgTop.r * (1 - ratio) + bgBottom.r * ratio),
      g: Math.round(bgTop.g * (1 - ratio) + bgBottom.g * ratio),
      b: Math.round(bgTop.b * (1 - ratio) + bgBottom.b * ratio),
    };
    fillRect(frame, width, height, 0, y, width, 1, color);
  }

  fillRect(frame, width, height, 0, 0, width, 42, { r: 14, g: 17, b: 25 });
  fillRect(frame, width, height, 22, 14, 12, 12, { r: 255, g: 95, b: 86 });
  fillRect(frame, width, height, 42, 14, 12, 12, { r: 255, g: 189, b: 46 });
  fillRect(frame, width, height, 62, 14, 12, 12, { r: 39, g: 201, b: 63 });
  drawText(frame, width, height, 96, 13, "ANYENV CLI DESKTOP", 2, { r: 232, g: 238, b: 246 });

  fillRect(frame, width, height, 36, 72, width - 72, height - 126, { r: 11, g: 18, b: 29 });
  fillRect(frame, width, height, 36, 72, width - 72, 32, { r: 23, g: 31, b: 45 });
  drawText(frame, width, height, 54, 84, "REMOTE DESKTOP READY", 2, { r: 136, g: 245, b: 190 });
  drawText(frame, width, height, 58, 132, "NO SYSTEM VNC REQUIRED", 3, { r: 241, g: 245, b: 249 });
  drawText(frame, width, height, 58, 184, `HOST ${state.hostname}`, 2, { r: 167, g: 178, b: 194 });
  drawText(frame, width, height, 58, 214, `PLATFORM ${state.platform}`, 2, { r: 167, g: 178, b: 194 });
  drawText(frame, width, height, 58, 244, `PID ${process.pid}`, 2, { r: 167, g: 178, b: 194 });
  drawText(frame, width, height, 58, 274, `UP ${Math.round((Date.now() - state.startedAt) / 1000)}S`, 2, { r: 167, g: 178, b: 194 });
  drawText(frame, width, height, 58, 326, `LAST INPUT ${state.lastInput || "-"}`, 2, { r: 252, g: 211, b: 77 });
  drawText(frame, width, height, 58, 356, `POINTER ${state.pointerX} ${state.pointerY}`, 2, { r: 147, g: 197, b: 253 });

  fillRect(frame, width, height, state.pointerX - 4, state.pointerY - 4, 9, 9, { r: 255, g: 255, b: 255 });
  fillRect(frame, width, height, state.pointerX - 2, state.pointerY - 2, 5, 5, { r: 40, g: 90, b: 255 });
  return frame;
}

function serverPixelFormat() {
  return Buffer.from([
    32, 24, 0, 1,
    0, 255,
    0, 255,
    0, 255,
    16, 8, 0,
    0, 0, 0,
  ]);
}

function serverInit(state) {
  const name = Buffer.from("AnyEnv CLI Embedded Desktop", "utf8");
  return Buffer.concat([
    writeU16(state.width),
    writeU16(state.height),
    serverPixelFormat(),
    writeU32(name.length),
    name,
  ]);
}

function sendFramebufferUpdate(socket, state) {
  const frame = drawDesktopFrame(state);
  const header = Buffer.concat([
    Buffer.from([0, 0]),
    writeU16(1),
    writeU16(0),
    writeU16(0),
    writeU16(state.width),
    writeU16(state.height),
    writeI32(0),
  ]);
  socket.write(Buffer.concat([header, frame]));
}

function keyName(keysym) {
  if (keysym >= 32 && keysym <= 126) return String.fromCharCode(keysym);
  const names = new Map([
    [0xff08, "BACKSPACE"],
    [0xff09, "TAB"],
    [0xff0d, "ENTER"],
    [0xff1b, "ESC"],
    [0xff51, "LEFT"],
    [0xff52, "UP"],
    [0xff53, "RIGHT"],
    [0xff54, "DOWN"],
  ]);
  return names.get(keysym) || `KEY ${keysym}`;
}

function handleClient(socket, baseState) {
  const state = {
    ...baseState,
    buffer: Buffer.alloc(0),
    phase: "version",
    lastInput: "",
    pointerX: Math.round(baseState.width / 2),
    pointerY: Math.round(baseState.height / 2),
  };
  socket.setNoDelay(true);
  socket.write(SERVER_VERSION);

  const take = (size) => {
    const chunk = state.buffer.subarray(0, size);
    state.buffer = state.buffer.subarray(size);
    return chunk;
  };

  const processBuffer = () => {
    while (state.buffer.length) {
      if (state.phase === "version") {
        if (state.buffer.length < 12) return;
        take(12);
        socket.write(Buffer.from([1, 1]));
        state.phase = "security";
        continue;
      }
      if (state.phase === "security") {
        if (state.buffer.length < 1) return;
        const choice = take(1)[0];
        if (choice !== 1) {
          socket.destroy(new Error("unsupported RFB security type"));
          return;
        }
        socket.write(writeU32(0));
        state.phase = "client-init";
        continue;
      }
      if (state.phase === "client-init") {
        if (state.buffer.length < 1) return;
        take(1);
        socket.write(serverInit(state));
        state.phase = "normal";
        continue;
      }

      const messageType = state.buffer[0];
      if (messageType === 0) {
        if (state.buffer.length < 20) return;
        take(20);
        continue;
      }
      if (messageType === 2) {
        if (state.buffer.length < 4) return;
        const count = state.buffer.readUInt16BE(2);
        const size = 4 + count * 4;
        if (state.buffer.length < size) return;
        take(size);
        continue;
      }
      if (messageType === 3) {
        if (state.buffer.length < 10) return;
        take(10);
        sendFramebufferUpdate(socket, state);
        continue;
      }
      if (messageType === 4) {
        if (state.buffer.length < 8) return;
        const down = state.buffer[1] === 1;
        const keysym = state.buffer.readUInt32BE(4);
        take(8);
        if (down) state.lastInput = keyName(keysym);
        continue;
      }
      if (messageType === 5) {
        if (state.buffer.length < 6) return;
        state.pointerX = clamp(state.buffer.readUInt16BE(2), 0, state.width - 1);
        state.pointerY = clamp(state.buffer.readUInt16BE(4), 0, state.height - 1);
        take(6);
        continue;
      }
      if (messageType === 6) {
        if (state.buffer.length < 8) return;
        const length = state.buffer.readUInt32BE(4);
        if (state.buffer.length < 8 + length) return;
        const text = state.buffer.subarray(8, 8 + length).toString("utf8").trim();
        state.lastInput = text ? text.slice(0, 24) : "CLIPBOARD";
        take(8 + length);
        continue;
      }
      socket.destroy(new Error(`unsupported RFB client message ${messageType}`));
      return;
    }
  };

  socket.on("data", (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    processBuffer();
  });
}

export async function startEmbeddedVncServer(options = {}) {
  const width = clamp(Number(options.width || process.env.ANYENV_EMBEDDED_VNC_WIDTH || DEFAULT_WIDTH), 320, 1920);
  const height = clamp(Number(options.height || process.env.ANYENV_EMBEDDED_VNC_HEIGHT || DEFAULT_HEIGHT), 240, 1080);
  const sockets = new Set();
  const baseState = {
    width,
    height,
    startedAt: Date.now(),
    hostname: String(options.hostname || os.hostname() || "local").slice(0, 24),
    platform: `${process.platform}-${process.arch}`.slice(0, 24),
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleClient(socket, baseState);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  return {
    host: "127.0.0.1",
    port: typeof address === "object" && address ? address.port : 0,
    mode: "cli-managed-rfb",
    source: "cli-embedded",
    close() {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // Ignore close races.
        }
      }
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
