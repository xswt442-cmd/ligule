// 把画好的 PNG 装进 icon.ico：头部 + 每个尺寸一条目录项 + 各自的 PNG 数据。
// PNG 压缩的图标条目从 Vista 起合法，所以容器里不需要另存一份位图。
// 写完自己读回来查一遍：目录项说的偏移与长度要落在文件里，PNG 签名要对得上。
// 用法：node desktop/make-ico.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = new URL('./src-tauri/icons/', import.meta.url).pathname.replace(/^\//, '');
const entries = [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256]];

const images = entries.map(([name, size]) => ({ size, bytes: readFileSync(join(directory, name)) }));
const headerSize = 6 + 16 * images.length;
const buffer = Buffer.alloc(headerSize + images.reduce((total, image) => total + image.bytes.length, 0));

buffer.writeUInt16LE(1, 2);
buffer.writeUInt16LE(images.length, 4);
let offset = headerSize;
images.forEach((image, index) => {
  const at = 6 + 16 * index;
  buffer.writeUInt8(image.size >= 256 ? 0 : image.size, at);
  buffer.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
  buffer.writeUInt16LE(1, at + 4);
  buffer.writeUInt16LE(32, at + 6);
  buffer.writeUInt32LE(image.bytes.length, at + 8);
  buffer.writeUInt32LE(offset, at + 12);
  image.bytes.copy(buffer, offset);
  offset += image.bytes.length;
});

writeFileSync(join(directory, 'icon.ico'), buffer);

const written = readFileSync(join(directory, 'icon.ico'));
const count = written.readUInt16LE(4);
let end = 0;
for (let index = 0; index < count; index += 1) {
  const at = 6 + 16 * index;
  const length = written.readUInt32LE(at + 8);
  const start = written.readUInt32LE(at + 12);
  if (written.readUInt32BE(start) !== 0x89504e47) throw new Error(`entry ${index} does not start with a PNG signature`);
  end = Math.max(end, start + length);
}
if (end !== written.length) throw new Error(`the last entry ends at ${end}, the file is ${written.length} bytes`);
console.log(`icon.ico: ${count} entries, ${written.length} bytes`);
