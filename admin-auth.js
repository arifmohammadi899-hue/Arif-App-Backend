const crypto = require("crypto");

const COOKIE = "arif_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;

function secret() {
  const value = process.env.ARIF_SESSION_SECRET || "";
  if (Buffer.byteLength(value) < 32) {
    throw new Error("ARIF_SESSION_SECRET must be at least 32 bytes");
  }
  return value;
}

function createSession(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })).toString("base64url");

  const signature = crypto.createHmac("sha256", secret())
    .update(payload).digest("base64url");

  return payload + "." + signature;
}

function verifySession(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) return false;

    const expected = crypto.createHmac("sha256", secret())
      .update(parts[0]).digest();
    const actual = Buffer.from(parts[1], "base64url");

    if (actual.length !== expected.length ||
        !crypto.timingSafeEqual(actual, expected)) return false;

    const data = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    );

    return data.username === process.env.ADMIN_USER &&
      Number.isFinite(data.exp) &&
      data.exp > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

function isAdmin(req) {
  const cookies = String(req.headers.cookie || "");
  const entry = cookies.split(";").map(x => x.trim())
    .find(x => x.startsWith(COOKIE + "="));

  return entry ? verifySession(entry.slice(COOKIE.length + 1)) : false;
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", COOKIE + "=" + token +
    "; Max-Age=" + SESSION_SECONDS +
    "; Path=/; HttpOnly; Secure; SameSite=Strict");
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", COOKIE +
    "=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict");
}

module.exports = {
  createSession,
  isAdmin,
  setSessionCookie,
  clearSessionCookie
};
