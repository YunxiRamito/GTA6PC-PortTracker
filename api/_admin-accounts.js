'use strict';

const { randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify, TextDecoder } = require('node:util');
const { inflateSync } = require('node:zlib');
const { ContentError } = require('./_content');
const { cleanDanmakuNickname } = require('./_danmaku-filter');

const VERSION = 1;
const MAX_ACCOUNTS = 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AVATAR_BYTES = 72 * 1024;
const AVATAR_SIZE = 128;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_CHANNELS = { 2: 3, 6: 4 };
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});
const EMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const EMAIL_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const EMPTY_PROFILE = { nickname: '', email: '', avatar: '' };
const PROFILE_KEYS = new Set(Object.keys(EMPTY_PROFILE));
const ROLES = new Set(['owner', 'admin', 'moderator', 'user']);
const LIMITED_ROLES = new Set(['moderator', 'user']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const SECRET_BYTES = 32;
const PASSWORD_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// These parameters and the encoding are part of the v1 file format.
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const deriveKey = promisify(scrypt);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const storageError = () => new ContentError(503, '账号存储暂时不可用');
const forbidden = () => new ContentError(403, '无权管理账号');
const avatarError = () => new ContentError(400, '头像须为 128×128 的 PNG，且不超过 72 KiB');
const timestampIsValid = value => Number.isSafeInteger(value) && value >= 0;

function validUsername(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 32 && !/[^A-Za-z0-9._-]/.test(value);
}

function passwordLength(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\uD800-\uDFFF]/u.test(value)) return 0;
  return Array.from(value).length;
}

// Verify existing credentials even if they were created under an earlier rule.
function validPasswordInput(value) {
  const length = passwordLength(value);
  return length > 0 && length <= 128;
}

function checkNewPassword(value) {
  const length = passwordLength(value);
  if (length < 8 || length > 128 || !/[A-Za-z]/.test(value)) {
    throw new ContentError(400, '密码至少 8 个字符，并包含至少 1 个英文字母，最多 128 个字符');
  }
}

function checkUsername(value) {
  if (!validUsername(value)) throw new ContentError(400, '用户名须为 3–32 个英文字母、数字或 . _ -');
}

function checkRole(role) {
  if (!ROLES.has(role)) throw new ContentError(400, '账号角色无效');
}

function identity({ id, uid, username, role, credentialVersion, needsPasswordChange, nickname }) {
  return { id, uid, username, role, credentialVersion, needsPasswordChange, nickname };
}

function profile(account) {
  return { ...identity(account), email: account.email, avatar: account.avatar };
}

function normalizeNickname(value) {
  const nickname = typeof value === 'string' && value.length <= 128 ? cleanDanmakuNickname(value) : null;
  if (nickname === null) throw new ContentError(400, '昵称不符合要求，请换一个');
  return nickname;
}

function nicknameKey(value) {
  return value ? value.normalize('NFKC').toLocaleLowerCase('en-US') : '';
}

function assertUniqueNickname(accounts, nickname, exceptId) {
  const key = nicknameKey(nickname);
  if (!key) return;
  for (const account of accounts.values()) {
    if (account.id !== exceptId && nicknameKey(account.nickname) === key) {
      throw new ContentError(409, '这个昵称已被使用，请换一个。');
    }
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[^\x20-\x7e]/.test(value)) {
    throw new ContentError(400, '邮箱格式有误');
  }
  const email = value.trim();
  if (!email) return '';
  const [local, domain, extra] = email.split('@');
  if (!domain || extra !== undefined || local.length > 64 || !EMAIL_LOCAL.test(local) || !EMAIL_DOMAIN.test(domain)) {
    throw new ContentError(400, '邮箱格式有误');
  }
  return `${local}@${domain.toLowerCase()}`;
}

function pngCRC(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function checkPngPixels(imageChunks, stride) {
  const data = Buffer.concat(imageChunks);
  const size = AVATAR_SIZE * stride;
  try {
    const { buffer, engine } = inflateSync(data, { maxOutputLength: size, info: true });
    if (buffer.length !== size || engine.bytesWritten !== data.length) throw avatarError();
    for (let offset = 0; offset < size; offset += stride) {
      if (buffer[offset] > 4) throw avatarError();
    }
  } catch {
    throw avatarError();
  }
}

// Canvas exports non-interlaced RGB or RGBA. Keep the image data and discard metadata.
function cleanAvatar(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX) ||
      value.length > PNG_PREFIX.length + 4 * Math.ceil(MAX_AVATAR_BYTES / 3)) throw avatarError();
  const encoded = value.slice(PNG_PREFIX.length);
  const png = Buffer.from(encoded, 'base64');
  if (png.length > MAX_AVATAR_BYTES || png.toString('base64') !== encoded ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw avatarError();

  const keptChunks = [PNG_SIGNATURE];
  const imageChunks = [];
  let stride = 0;
  let colorType;
  let seenTransparency = false;
  let endedImage = false;
  for (let offset = PNG_SIGNATURE.length; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) throw avatarError();
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, end - 4);
    if (!/^[a-zA-Z]{2}[A-Z][a-zA-Z]$/.test(type) ||
        pngCRC(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4) || (!stride && type !== 'IHDR')) {
      throw avatarError();
    }

    const chunk = png.subarray(offset, end);
    offset = end;
    if (type === 'IHDR') {
      colorType = data[9];
      if (stride || length !== 13 || data.readUInt32BE(0) !== AVATAR_SIZE || data.readUInt32BE(4) !== AVATAR_SIZE ||
          data[8] !== 8 || !PNG_CHANNELS[colorType] || data[10] || data[11] || data[12]) throw avatarError();
      stride = 1 + AVATAR_SIZE * PNG_CHANNELS[colorType];
    } else if (type === 'IDAT') {
      if (endedImage) throw avatarError();
      imageChunks.push(data);
    } else if (type === 'IEND') {
      if (length || end !== png.length || !imageChunks.length) throw avatarError();
      checkPngPixels(imageChunks, stride);
      keptChunks.push(chunk);
      return PNG_PREFIX + Buffer.concat(keptChunks).toString('base64');
    } else if (type === 'tRNS') {
      if (seenTransparency || imageChunks.length || colorType !== 2 || length !== 6 || data[0] || data[2] || data[4]) {
        throw avatarError();
      }
      seenTransparency = true;
    } else {
      // PLTE can be a suggested palette for truecolor. Other critical chunks are unknown.
      if (type !== 'PLTE' && /^[A-Z]/.test(type)) throw avatarError();
      if (imageChunks.length) endedImage = true;
      continue;
    }
    keptChunks.push(chunk);
  }
  throw avatarError();
}

function profileFields({ nickname, email, avatar }, current = EMPTY_PROFILE) {
  return {
    nickname: nickname === undefined ? current.nickname : normalizeNickname(nickname ?? ''),
    email: email === undefined ? current.email : normalizeEmail(email ?? ''),
    avatar: avatar === undefined ? current.avatar : cleanAvatar(avatar ?? ''),
  };
}

async function hashPassword(password, salt) {
  try {
    return await deriveKey(password, Buffer.from(salt, 'hex'), SECRET_BYTES, SCRYPT_OPTIONS);
  } catch {
    throw storageError();
  }
}

async function newCredential(password) {
  const salt = randomBytes(SECRET_BYTES).toString('hex');
  const hash = await hashPassword(password, salt);
  return { salt, hash: hash.toString('hex') };
}

async function verifyPassword({ salt, hash }, password) {
  const actual = await hashPassword(password, salt);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

function indexAccounts(accounts, nextUid) {
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > MAX_ACCOUNTS) throw storageError();
  const byId = new Map();
  const idsByUsername = new Map();
  const usedUids = new Set();
  // Earlier files preserve registration order and contain no numeric IDs.
  const needsUidBackfill = accounts.every(account => account && !Object.hasOwn(account, 'uid'));
  let minimumNextUid = 1;
  let hasOwner = false;
  for (const [position, row] of accounts.entries()) {
    if (!row || typeof row !== 'object') throw storageError();
    const { id, username, role, credentialVersion, needsPasswordChange, salt, hash, createdAt, updatedAt } = row;
    if (typeof id !== 'string' || !ID.test(id) || !validUsername(username) || !ROLES.has(role) ||
        !Number.isSafeInteger(credentialVersion) || credentialVersion < 1 || typeof needsPasswordChange !== 'boolean' ||
        typeof salt !== 'string' || !HEX_32.test(salt) || typeof hash !== 'string' || !HEX_32.test(hash) ||
        !timestampIsValid(createdAt) || !timestampIsValid(updatedAt)) throw storageError();
    const uid = needsUidBackfill ? position + 1 : row.uid;
    if (!Number.isSafeInteger(uid) || uid < 1 || uid >= Number.MAX_SAFE_INTEGER || usedUids.has(uid)) throw storageError();
    usedUids.add(uid);
    minimumNextUid = Math.max(minimumNextUid, uid + 1);
    const key = username.toLowerCase();
    if (byId.has(id) || idsByUsername.has(key)) throw storageError();
    byId.set(id, {
      id, uid, username, role, credentialVersion, needsPasswordChange, salt, hash, createdAt, updatedAt, ...profileFields(row),
    });
    idsByUsername.set(key, id);
    if (role === 'owner') hasOwner = true;
  }
  if (!hasOwner) throw storageError();
  const needsCounterMigration = nextUid === undefined;
  if (needsCounterMigration) {
    nextUid = minimumNextUid;
  } else if (needsUidBackfill || !Number.isSafeInteger(nextUid) || nextUid < minimumNextUid) {
    throw storageError();
  }
  return { byId, idsByUsername, nextUid, needsCounterMigration };
}

async function readAccounts(filePath) {
  try {
    const entry = await fs.lstat(filePath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return null;
    if (!entry.isFile()) throw storageError();

    const file = await fs.open(filePath, READ_FLAGS);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) throw storageError();
      const data = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await file.read(data, length, data.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw storageError();
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)));
      if (saved?.version !== VERSION) throw storageError();
      return indexAccounts(saved.accounts, saved.nextUid);
    } finally {
      await file.close();
    }
  } catch {
    // Parse errors can include snippets of the file; never surface them.
    throw storageError();
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The file was already published; some filesystems do not support directory fsync.
  }
}

async function writeAccounts(filePath, accounts, nextUid, { bootstrap = false } = {}) {
  const bytes = Buffer.from(`${JSON.stringify({ version: VERSION, nextUid, accounts: [...accounts] })}\n`);
  if (bytes.length > MAX_FILE_BYTES) throw new ContentError(409, '账号存储空间已满');
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.admin-accounts-${randomUUID()}.tmp`);
  let removeTemporary = false;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await fs.open(temporary, 'wx', 0o600);
    removeTemporary = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }

    if (bootstrap) {
      // Publish without replacing a file that appeared while we hashed the password.
      try {
        await fs.link(temporary, filePath);
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
    } else {
      await fs.rename(temporary, filePath);
      removeTemporary = false;
    }
    await syncDirectory(directory);
    return true;
  } catch {
    throw storageError();
  } finally {
    if (removeTemporary) await fs.unlink(temporary).catch(() => {});
  }
}

// Use one live store per file in a private runtime directory (Windows: restrict its ACL).
// Await initialize() before serving requests. Passwords are used as typed.
function createAdminAccounts({ filePath, bootstrap, confirmedInitialOwner, now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof now !== 'function') throw storageError();
  const location = path.resolve(filePath);
  const dummy = { salt: randomBytes(SECRET_BYTES).toString('hex'), hash: randomBytes(SECRET_BYTES).toString('hex') };
  let state;
  let initializing;
  let pending = Promise.resolve();

  function timestamp() {
    const at = now();
    if (!timestampIsValid(at)) throw storageError();
    return at;
  }

  function loaded() {
    if (!state) throw storageError();
    return state;
  }

  function serialize(work) {
    const task = pending.then(work);
    pending = task.catch(() => {});
    return task;
  }

  async function newAccount(uid, username, password, role, fields = EMPTY_PROFILE, needsPasswordChange = true) {
    const at = timestamp();
    return {
      id: randomUUID(), uid, username, role, credentialVersion: 1, needsPasswordChange,
      createdAt: at, updatedAt: at, ...fields, ...await newCredential(password),
    };
  }

  async function load() {
    let next = await readAccounts(location);
    if (!next) {
      if (bootstrap === undefined) throw new ContentError(503, '请先配置初始所有者账号');
      const { username, password } = bootstrap ?? {};
      checkUsername(username);
      checkNewPassword(password);
      const owner = await newAccount(1, username, password, 'owner');
      const installed = await writeAccounts(location, [owner], 2, { bootstrap: true });
      next = installed ? indexAccounts([owner], 2) : await readAccounts(location);
      if (!next) throw storageError();
    }
    const { byId, idsByUsername, nextUid, needsCounterMigration } = next;
    let shouldPersist = needsCounterMigration;
    const initialOwner = [...byId.values()].find(account => account.uid === 1);
    if (confirmedInitialOwner && initialOwner?.username === confirmedInitialOwner && initialOwner.role === 'owner' &&
        initialOwner.credentialVersion === 1 && initialOwner.needsPasswordChange) {
      // An operator can confirm that the original owner supplied their own initial password.
      byId.set(initialOwner.id, { ...initialOwner, needsPasswordChange: false, updatedAt: timestamp() });
      shouldPersist = true;
    }
    if (shouldPersist) await writeAccounts(location, byId.values(), nextUid);
    state = { byId, idsByUsername, nextUid };
    bootstrap = undefined;
  }

  async function initialize() {
    if (state) return;
    if (!initializing) {
      initializing = load().finally(() => { initializing = undefined; });
    }
    await initializing;
  }

  async function authenticate(username, password) {
    const { byId, idsByUsername } = loaded();
    const valid = validPasswordInput(password);
    const account = valid && validUsername(username) ? byId.get(idsByUsername.get(username.toLowerCase())) : undefined;
    const matches = await verifyPassword(account ?? dummy, valid ? password : '');
    if (!account || !matches) return null;

    // A committed rotation or deletion invalidates an in-flight credential check.
    const latest = state.byId.get(account.id);
    return latest?.credentialVersion === account.credentialVersion ? identity(latest) : null;
  }

  function get(id) {
    const account = loaded().byId.get(id);
    return account ? identity(account) : null;
  }

  function getProfile(id) {
    const account = loaded().byId.get(id);
    return account ? profile(account) : null;
  }

  function list(actorId) {
    const { byId } = loaded();
    const actor = byId.get(actorId);
    if (actor?.role !== 'owner' && actor?.role !== 'admin') throw forbidden();
    return [...byId.values()].map(identity);
  }

  async function persist(next) {
    await writeAccounts(location, next.byId.values(), next.nextUid);
    state = next;
  }

  async function commit(account, nextUid = state.nextUid) {
    const byId = new Map(state.byId).set(account.id, account);
    const idsByUsername = new Map(state.idsByUsername).set(account.username.toLowerCase(), account.id);
    await persist({ byId, idsByUsername, nextUid });
    return account;
  }

  async function addAccount(username, password, role, input, needsPasswordChange) {
    const { byId, idsByUsername, nextUid } = loaded();
    checkUsername(username);
    checkNewPassword(password);
    checkRole(role);
    if (idsByUsername.has(username.toLowerCase())) throw new ContentError(409, '用户名已存在');
    if (byId.size >= MAX_ACCOUNTS) throw new ContentError(409, '账号数量已达上限');
    if (nextUid >= Number.MAX_SAFE_INTEGER) throw storageError();
    const fields = profileFields(input);
    assertUniqueNickname(byId, fields.nickname);
    const account = await newAccount(nextUid, username, password, role, fields, needsPasswordChange);
    if (byId.has(account.id)) throw storageError();
    return commit(account, nextUid + 1);
  }

  async function create(actorId, input) {
    const { username, password, role = 'user' } = input ?? {};
    return serialize(async () => {
      if (loaded().byId.get(actorId)?.role !== 'owner') throw forbidden();
      return identity(await addAccount(username, password, role, EMPTY_PROFILE, true));
    });
  }

  async function register(input) {
    const { username, password, nickname, email, avatar } = input ?? {};
    return serialize(async () => profile(await addAccount(username, password, 'user', { nickname, email, avatar }, false)));
  }

  async function updateProfile(id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ContentError(400, '资料格式有误');
    if (Object.keys(patch).some(key => !PROFILE_KEYS.has(key))) throw new ContentError(400, '只能修改昵称、邮箱或头像');
    const { nickname, email, avatar } = patch;
    return serialize(async () => {
      const account = loaded().byId.get(id);
      if (!account) throw new ContentError(401, '请先登录后台');
      const fields = profileFields({ nickname, email, avatar }, account);
      assertUniqueNickname(loaded().byId, fields.nickname, id);
      if (fields.nickname === account.nickname && fields.email === account.email && fields.avatar === account.avatar) {
        return profile(account);
      }
      return profile(await commit({ ...account, ...fields, updatedAt: timestamp() }));
    });
  }

  function setRole(actorId, targetId, role) {
    return serialize(async () => {
      const { byId } = loaded();
      const actor = byId.get(actorId);
      if (actor?.role !== 'owner' && actor?.role !== 'admin') throw forbidden();
      checkRole(role);
      const target = byId.get(targetId);
      if (!target) throw new ContentError(404, '账号不存在');
      if (actor.role === 'admin' && (target.id === actor.id || !LIMITED_ROLES.has(target.role) || !LIMITED_ROLES.has(role))) {
        throw forbidden();
      }
      if (target.role === role) return identity(target);
      if (target.role === 'owner' && ![...byId.values()].some(account => account.id !== targetId && account.role === 'owner')) {
        throw new ContentError(409, '至少保留一个所有者');
      }
      return identity(await commit({ ...target, role, updatedAt: timestamp() }));
    });
  }

  function ownerTarget(actorId, targetId) {
    const { byId } = loaded();
    if (byId.get(actorId)?.role !== 'owner' || actorId === targetId) throw forbidden();
    const target = byId.get(targetId);
    if (!target) throw new ContentError(404, '账号不存在');
    return target;
  }

  async function rotateCredential(account, password, needsPasswordChange) {
    if (account.credentialVersion === Number.MAX_SAFE_INTEGER) throw storageError();
    return identity(await commit({
      ...account, ...await newCredential(password), updatedAt: timestamp(),
      credentialVersion: account.credentialVersion + 1, needsPasswordChange,
    }));
  }

  async function resetPassword(actorId, targetId) {
    return serialize(async () => {
      const target = ownerTarget(actorId, targetId);
      const temporaryPassword = Array.from({ length: 24 },
        () => PASSWORD_LETTERS[randomInt(PASSWORD_LETTERS.length)]).join('');
      const account = await rotateCredential(target, temporaryPassword, true);
      return { account, temporaryPassword };
    });
  }

  async function deleteAccount(actorId, targetId, confirmUsername) {
    return serialize(async () => {
      // A distinct acting owner guarantees that at least one owner remains.
      const target = ownerTarget(actorId, targetId);
      if (confirmUsername !== target.username) throw new ContentError(400, '确认用户名与目标账号不一致');
      const { byId, idsByUsername, nextUid } = loaded();
      const remaining = new Map(byId);
      const remainingUsernames = new Map(idsByUsername);
      remaining.delete(target.id);
      remainingUsernames.delete(target.username.toLowerCase());
      await persist({ byId: remaining, idsByUsername: remainingUsernames, nextUid });
      return { uid: target.uid };
    });
  }

  function changePassword(actorId, currentPassword, newPassword) {
    return serialize(async () => {
      const account = loaded().byId.get(actorId);
      if (!account) throw new ContentError(401, '请先登录后台');
      checkNewPassword(newPassword);
      if (!validPasswordInput(currentPassword) || !await verifyPassword(account, currentPassword)) {
        throw new ContentError(400, '当前密码不正确');
      }
      if (newPassword === currentPassword) throw new ContentError(400, '新密码不能与当前密码相同');
      return rotateCredential(account, newPassword, false);
    });
  }

  return { initialize, authenticate, get, getProfile, list, create, register, updateProfile, setRole, changePassword, resetPassword, deleteAccount };
}

module.exports = { createAdminAccounts };
