const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const mongoose = require("mongoose");
const path = require("path");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals < 1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const app = express();
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const TOMBSTONE_HASH_SECRET =
  process.env.TOMBSTONE_HASH_SECRET || DISCORD_CLIENT_SECRET || ADMIN_PASSWORD;
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/discord/callback`;

const OWNER_DISCORD_ID = "1147930457439223920";
const HANDLE_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const VERIFICATION_APPLICATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const APPEAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LOGO_PATH = path.resolve(__dirname, "public", "images", "chripy.png");

if (!MONGODB_URI) {
  throw new Error("Add MONGODB_URI to your .env file to use persistent accounts.");
}
if (!ADMIN_PASSWORD) {
  throw new Error("Add ADMIN_PASSWORD to your .env file.");
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "7mb" }));

// Keep the public URL correctly spelled while serving the existing asset.
app.get("/images/chirpy.png", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");

  if (!fs.existsSync(LOGO_PATH)) {
    return sendAppError(req, res, 404, "The Chirpy logo could not be loaded.");
  }

  return res.sendFile(LOGO_PATH, (error) => {
    if (error) next(error);
  });
});

app.use(express.static(path.join(__dirname, "public")));

const userSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    handle: { type: String, lowercase: true, trim: true },
    displayName: { type: String, required: true, maxlength: 40 },
    avatar: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 160 },
    handleChangedAt: { type: Date, default: null },
    role: {
      type: String,
      enum: ["user", "moderator", "manager", "owner"],
      default: "user",
    },
    partner: { type: Boolean, default: false },
    muted: { type: Boolean, default: false },
    mutedUntil: { type: Date, default: null },
    mutedReason: { type: String, default: "", maxlength: 300 },
    mutedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    socialNotificationsEnabled: { type: Boolean, default: true },
    terminated: { type: Boolean, default: false },
    terminationReason: { type: String, default: "", maxlength: 500 },
    terminatedAt: { type: Date, default: null },
    terminatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    appealUsed: { type: Boolean, default: false },
    appealStatus: {
      type: String,
      enum: ["pending", "accepted", "denied", "expired", null],
      default: null,
    },
    appealText: { type: String, default: "", maxlength: 2000 },
    appealSubmittedAt: { type: Date, default: null },
    appealDecisionAt: { type: Date, default: null },
    appealDecisionBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    verificationStatus: {
      type: String,
      enum: ["none", "pending", "verified", "rejected"],
      default: "none",
    },
    verificationReason: { type: String, default: "", maxlength: 500 },
    verificationAppliedAt: { type: Date, default: null },
    verificationLastAppliedAt: { type: Date, default: null },
    verificationRemovalNotice: { type: Boolean, default: false },
  },
  { timestamps: true }
);
userSchema.index(
  { handle: 1 },
  {
    unique: true,
    sparse: true,
    collation: { locale: "en", strength: 2 },
  }
);

const commentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    handle: { type: String, required: true },
    text: { type: String, required: true, maxlength: 300 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const pollSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, maxlength: 180 },
    options: [
      {
        text: { type: String, required: true, maxlength: 80 },
      },
    ],
    votes: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, required: true },
        optionIndex: { type: Number, required: true, min: 0, max: 3 },
      },
    ],
  },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    text: { type: String, default: "", maxlength: 500 },
    imageData: { type: Buffer, default: null },
    imageMime: {
      type: String,
      enum: ["image/png", "image/jpeg", "image/gif", "image/webp", null],
      default: null,
    },
    likes: [{ type: mongoose.Schema.Types.ObjectId }],
    reposts: [{ type: mongoose.Schema.Types.ObjectId }],
    bookmarks: [{ type: mongoose.Schema.Types.ObjectId }],
    poll: { type: pollSchema, default: null },
    comments: [commentSchema],
    deleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);
postSchema.index({ authorId: 1, createdAt: -1 });

const messageSchema = new mongoose.Schema(
  {
    senderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    text: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: true }
);

const notificationSchema = new mongoose.Schema(
  {
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    postId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    eventKey: { type: String, default: undefined },
    type: {
      type: String,
      enum: ["mention", "follow", "comment", "like", "repost", "message"],
      required: true,
    },
    unread: { type: Boolean, default: true, index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
notificationSchema.index(
  { eventKey: 1 },
  { unique: true, sparse: true, name: "notification_event_key_unique" }
);

const followSchema = new mongoose.Schema(
  {
    followerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    followingId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, versionKey: false }
);
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ followingId: 1, createdAt: -1 });

const auditSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    targetId: { type: String, default: "" },
    details: { type: String, default: "" },
  },
  { timestamps: true }
);

const accountTombstoneSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
    },
    normalizedHandle: { type: String, lowercase: true, trim: true, default: undefined },
    discordIdHash: { type: String, required: true, unique: true },
    terminatedAt: { type: Date, required: true },
    appealEligible: { type: Boolean, default: false },
    appealUsed: { type: Boolean, default: false },
    appealStatus: {
      type: String,
      enum: ["pending", "accepted", "denied", "expired", null],
      default: null,
    },
    appealSubmittedAt: { type: Date, default: null },
    appealDecisionAt: { type: Date, default: null },
    appealDecisionBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    appealWindowExpiredAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);
accountTombstoneSchema.index(
  { normalizedHandle: 1 },
  { unique: true, sparse: true }
);

const maintenanceSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  enabled: { type: Boolean, default: true },
  progress: { type: Number, min: 0, max: 100, default: 2 },
  verificationEnabled: { type: Boolean, default: true },
});

const verificationOutcomeNoticeSchema = new mongoose.Schema(
  {
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    outcome: { type: String, enum: ["approved", "denied"], required: true },
    acknowledgedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
verificationOutcomeNoticeSchema.index({ recipientId: 1, acknowledgedAt: 1, createdAt: -1 });

const sessionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    adminVerified: { type: Boolean, default: false },
    discordState: { type: String, default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    terminatedUserId: { type: String, default: null },
    returnTo: { type: String, default: "/app" },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "chirpy_sessions" }
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const oauthStateSchema = new mongoose.Schema(
  {
    stateHash: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    returnTo: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "chirpy_oauth_states" }
);
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const pendingRoleAssignmentSchema = new mongoose.Schema(
  {
    discordId: { type: String, required: true, unique: true, index: true },
    role: {
      type: String,
      enum: ["moderator", "manager", "owner"],
      required: true,
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
const Post = mongoose.model("Post", postSchema);
const Message = mongoose.model("Message", messageSchema);
const Notification = mongoose.model("Notification", notificationSchema);
const Follow = mongoose.model("Follow", followSchema);
const AuditLog = mongoose.model("AuditLog", auditSchema);
const AccountTombstone = mongoose.model("AccountTombstone", accountTombstoneSchema);
const MaintenanceSettings = mongoose.model(
  "MaintenanceSettings",
  maintenanceSettingsSchema
);
const VerificationOutcomeNotice = mongoose.model(
  "VerificationOutcomeNotice",
  verificationOutcomeNoticeSchema
);
const PendingRoleAssignment = mongoose.model(
  "PendingRoleAssignment",
  pendingRoleAssignmentSchema
);
const ChirpySession = mongoose.model("ChirpySession", sessionSchema);
const OAuthState = mongoose.model("OAuthState", oauthStateSchema);

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createId() {
  return crypto.randomBytes(24).toString("hex");
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function sessionCookieSecureAttribute(req) {
  return req.secure ? "; Secure" : "";
}

function setSessionCookie(req, res, id, expiresAt = new Date(Date.now() + SESSION_TTL_MS)) {
  const secure = sessionCookieSecureAttribute(req);
  const maxAge = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  res.setHeader(
    "Set-Cookie",
    `chirpy_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}${secure}`
  );
}

async function getSession(req) {
  if (Object.hasOwn(req, "chirpySession")) return req.chirpySession;
  const id = readCookie(req, "chirpy_session");
  if (!id) return null;
  return ChirpySession.findOne({ _id: id, expiresAt: { $gt: new Date() } }).lean();
}

async function saveSession(session) {
  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await ChirpySession.updateOne(
    { _id: session._id },
    {
      $set: {
        adminVerified: Boolean(session.adminVerified),
        discordState: session.discordState || null,
        userId: session.userId || null,
        terminatedUserId: session.terminatedUserId || null,
        returnTo: safeReturnTo(session.returnTo || "/app"),
      },
      $max: { expiresAt: session.expiresAt },
    },
    { upsert: true }
  );
  return session;
}

async function getOrCreateSession(req, res) {
  const existing = await getSession(req);
  if (existing) return existing;

  const id = createId();
  const session = {
    _id: id,
    adminVerified: false,
    discordState: null,
    userId: null,
    terminatedUserId: null,
    returnTo: "/app",
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  };
  await ChirpySession.create(session);
  setSessionCookie(req, res, id, session.expiresAt);
  return session;
}

async function rotateSession(req, res, updates) {
  const oldId = readCookie(req, "chirpy_session");
  const previous = oldId ? await getSession(req) : null;
  if (oldId) await ChirpySession.deleteOne({ _id: oldId });

  const id = createId();
  const session = {
    ...(previous || {}),
    ...updates,
    _id: id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  };
  await ChirpySession.create(session);
  setSessionCookie(req, res, id, session.expiresAt);
  return session;
}

async function clearSession(req, res) {
  const id = readCookie(req, "chirpy_session");
  if (id) await ChirpySession.deleteOne({ _id: id });
  const secure = sessionCookieSecureAttribute(req);

  res.setHeader(
    "Set-Cookie",
    `chirpy_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=${new Date(0).toUTCString()}${secure}`
  );
}

app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const source = req.get("Origin") || req.get("Referer");
  if (!source) {
    return sendAppError(req, res, 403, "This request could not be verified. Reload Chirpy and try again.");
  }
  try {
    const sourceUrl = new URL(source);
    const expectedOrigin = `${req.protocol}://${req.get("host")}`;
    if (sourceUrl.origin !== expectedOrigin) {
      return sendAppError(req, res, 403, "This request came from another site and was blocked.");
    }
  } catch {
    return sendAppError(req, res, 403, "This request could not be verified. Reload Chirpy and try again.");
  }
  return next();
});

app.use(asyncRoute(async (req, res, next) => {
  const id = readCookie(req, "chirpy_session");
  if (!id) return next();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const session = await ChirpySession.findOneAndUpdate(
    { _id: id, expiresAt: { $gt: now } },
    { $max: { expiresAt } },
    { returnDocument: "after" }
  ).lean();
  if (!session) {
    req.chirpySession = null;
    res.setHeader(
      "Set-Cookie",
      `chirpy_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=${new Date(0).toUTCString()}${sessionCookieSecureAttribute(req)}`
    );
    return next();
  }
  req.chirpySession = session;
  setSessionCookie(req, res, id, session.expiresAt || expiresAt);
  return next();
}));

function safeCompare(first, second) {
  const a = Buffer.from(String(first || ""), "utf8");
  const b = Buffer.from(String(second || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeReturnTo(value, fallback = "/app") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  try {
    const parsed = new URL(value, "http://chirpy.local");
    if (parsed.origin !== "http://chirpy.local" || ["/login", "/logout", "/auth/discord", "/auth/discord/callback"].includes(parsed.pathname)) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function requestReturnTo(req, value, fallback = "/app") {
  if (typeof value !== "string") return fallback;
  if (value.startsWith("/")) return safeReturnTo(value, fallback);
  try {
    const parsed = new URL(value);
    if (parsed.host !== req.get("host")) return fallback;
    return safeReturnTo(`${parsed.pathname}${parsed.search}${parsed.hash}`, fallback);
  } catch {
    return fallback;
  }
}

function requestPrefersJson(req) {
  return Boolean(
    req.is("application/json") ||
    req.get("Accept")?.includes("application/json") ||
    req.get("X-Requested-With") === "XMLHttpRequest" ||
    (req.method === "POST" && /^\/posts(?:\/|$)/.test(req.path) && !/\/delete$/.test(req.path))
  );
}

function mutedResponse(req, res) {
  const message = "Your account is muted. Posting and interactions are disabled until the mute expires or staff removes it.";
  if (requestPrefersJson(req)) {
    return res.status(403).json({ success: false, message });
  }
  return redirectWithNotice(req, res, "muted");
}

function redirectWithNotice(req, res, notice, fallback = "/app") {
  const destination = requestReturnTo(req, req.get("Referrer") || fallback, fallback);
  const parsed = new URL(destination, "http://chirpy.local");
  parsed.searchParams.set("notice", notice);
  return res.redirect(`${parsed.pathname}${parsed.search}${parsed.hash}`);
}

function userIsMuted(user) {
  return Boolean(
    user.muted &&
    (!user.mutedUntil || new Date(user.mutedUntil).getTime() > Date.now())
  );
}

async function expireMuteIfNeeded(user) {
  if (user.muted && user.mutedUntil && new Date(user.mutedUntil).getTime() <= Date.now()) {
    user.muted = false;
    user.mutedUntil = null;
    user.mutedReason = "";
    user.mutedBy = null;
    await user.save();
  }
}

function canModerateTarget(actor, target) {
  if (
    target.discordId === OWNER_DISCORD_ID ||
    String(target._id) === String(actor._id)
  ) return false;
  const hierarchy = { user: 0, moderator: 1, manager: 2, owner: 3 };
  return hierarchy[actor.role] > hierarchy[target.role];
}

function muteDuration(value) {
  const durations = {
    "10m": 10 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };
  if (value === "permanent") return null;
  return Object.hasOwn(durations, value) ? new Date(Date.now() + durations[value]) : undefined;
}

function renderPage(res, page, locals = {}) {
  const context = {
    page,
    error: "",
    handleError: "",
    handle: "",
    displayName: "",
    saved: false,
    handleChangeAvailableAt: null,
    handleChangeAllowed: true,
    returnTo: "/app",
    notice: "",
    muteInfo: null,
    activeMutes: [],
    muteActorMap: {},
    auditLogs: [],
    auditActorMap: {},
    auditTargetMap: {},
    auditTotalPages: 1,
    logPage: 1,
    logQuery: "",
    pendingAppeals: [],
    appealNotice: "",
    verificationOutcomeNotice: null,
    verificationNotice: "",
    verificationApplicationAvailable: true,
    verificationApplicationAvailableAt: null,
    terminatedAccount: {
      displayName: "Chirpy account",
      reason: "",
      terminatedAt: null,
      appealUsed: false,
      appealStatus: "",
      appealSubmittedAt: null,
      appealDecisionAt: null,
      appealEligible: false,
      appealClosesAt: null,
    },
    activeTab: "home",
    profileView: "posts",
    query: "",
    muteQuery: "",
    banlandQuery: "",
    defaultOwnerDiscordId: OWNER_DISCORD_ID,
    pendingRoleAssignments: [],
    roleAssignmentUserMap: {},
    staffUsers: [],
    terminationActorMap: {},
    applications: [],
    verifiedUsers: [],
    terminatedUsers: [],
    posts: [],
    userMap: {},
    messages: [],
    notifications: [],
    notificationActorMap: {},
    unreadNotificationCount: 0,
    maintenanceSettings: { enabled: true, progress: 2, verificationEnabled: true },
    avatarUrl: accountAvatarUrl,
    ...locals,
  };

  for (const name of [
    "activeMutes",
    "applications",
    "auditLogs",
    "messages",
    "notifications",
    "pendingAppeals",
    "pendingRoleAssignments",
    "posts",
    "staffUsers",
    "terminatedUsers",
    "verifiedUsers",
  ]) {
    if (!Array.isArray(context[name])) context[name] = [];
  }
  for (const name of [
    "auditActorMap",
    "auditTargetMap",
    "messageUserMap",
    "muteActorMap",
    "notificationActorMap",
    "roleAssignmentUserMap",
    "terminationActorMap",
    "userMap",
  ]) {
    if (!context[name] || typeof context[name] !== "object" || Array.isArray(context[name])) {
      context[name] = {};
    }
  }
  for (const name of ["appealNotice", "banlandQuery", "logQuery", "muteQuery", "query"]) {
    if (typeof context[name] !== "string") context[name] = "";
  }
  if (!context.terminatedAccount || typeof context.terminatedAccount !== "object") {
    context.terminatedAccount = {
      displayName: "Chirpy account",
      reason: "",
      terminatedAt: null,
      appealUsed: false,
      appealStatus: "",
      appealSubmittedAt: null,
      appealDecisionAt: null,
      appealEligible: false,
      appealClosesAt: null,
    };
  }
  if (!context.maintenanceSettings || typeof context.maintenanceSettings !== "object") {
    context.maintenanceSettings = { enabled: true, progress: 2, verificationEnabled: true };
  } else {
    context.maintenanceSettings = {
      enabled: context.maintenanceSettings.enabled !== false,
      progress: Number.isFinite(Number(context.maintenanceSettings.progress))
        ? Math.min(100, Math.max(0, Number(context.maintenanceSettings.progress)))
        : 2,
      verificationEnabled: context.maintenanceSettings.verificationEnabled !== false,
    };
  }
  return res.render("index", context);
}

function sendAppError(req, res, status, message) {
  if (requestPrefersJson(req)) {
    return res.status(status).json({ success: false, message });
  }
  return renderPage(res.status(status), "error", {
    statusCode: status,
    statusMessage: message,
  });
}

function discordDefaultAvatarUrl(discordId) {
  const normalizedId = /^\d{1,20}$/.test(String(discordId || ""))
    ? String(discordId)
    : "0";
  const index = Number(BigInt(normalizedId) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function discordAvatarUrl(profile) {
  if (!profile.avatar) return discordDefaultAvatarUrl(profile.id);
  const extension = profile.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(
    profile.id
  )}/${encodeURIComponent(profile.avatar)}.${extension}?size=256`;
}

function accountAvatarUrl(account) {
  const avatar = String(account.avatar || "");
  if (
    /^https:\/\/cdn\.discordapp\.com\/avatars\/\d+\/[A-Za-z0-9_]+\.(?:png|gif|webp)(?:\?[^"'<>]*)?$/.test(
      avatar
    )
  ) {
    return avatar;
  }
  if (
    /^\d{1,20}$/.test(String(account.discordId || "")) &&
    /^[A-Za-z0-9_]+$/.test(avatar)
  ) {
    const extension = avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${encodeURIComponent(
      account.discordId
    )}/${encodeURIComponent(avatar)}.${extension}?size=256`;
  }
  return discordDefaultAvatarUrl(account.discordId);
}

function idKey(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value.toHexString === "function") return value.toHexString();
  if (value._id && value._id !== value) return idKey(value._id);
  return String(value);
}

function sniffImageMime(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function parseUploadedImage(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > 7 * 1024 * 1024) {
    return null;
  }

  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    dataUrl
  );
  if (!match) return null;

  const encoded = match[1];
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > 5 * 1024 * 1024 ||
    bytes.toString("base64") !== encoded
  ) {
    return null;
  }

  const mime = sniffImageMime(bytes);
  return mime ? { bytes, mime } : null;
}

function handleChangeAvailableAt(user) {
  if (!user.handleChangedAt) return null;
  return new Date(user.handleChangedAt.getTime() + HANDLE_COOLDOWN_MS);
}

function canModerate(user) {
  return ["moderator", "manager", "owner"].includes(user.role);
}

function canManageStaff(user) {
  return ["manager", "owner"].includes(user.role);
}

function verificationApplicationAvailable(lastAppliedAt, now = Date.now()) {
  if (!lastAppliedAt) return true;
  const lastAppliedTime = new Date(lastAppliedAt).getTime();
  return Number.isFinite(lastAppliedTime) &&
    lastAppliedTime <= now &&
    now - lastAppliedTime >= VERIFICATION_APPLICATION_COOLDOWN_MS;
}

function appealEligibility(terminatedAt, appealUsed, now = Date.now()) {
  if (appealUsed || !terminatedAt) return { eligible: false, closesAt: null };
  const terminatedTime = new Date(terminatedAt).getTime();
  if (!Number.isFinite(terminatedTime) || terminatedTime > now) {
    return { eligible: false, closesAt: null };
  }
  const closesAt = new Date(terminatedTime + APPEAL_WINDOW_MS);
  return { eligible: now < closesAt.getTime(), closesAt };
}

function withinReinstatementWindow(terminatedAt, now = Date.now()) {
  if (!terminatedAt) return false;
  const terminatedTime = new Date(terminatedAt).getTime();
  return (
    Number.isFinite(terminatedTime) &&
    terminatedTime <= now &&
    now < terminatedTime + APPEAL_WINDOW_MS
  );
}

function reinstatementWindowFilter() {
  return {
    $expr: {
      $and: [
        { $gt: ["$terminatedAt", { $subtract: ["$$NOW", APPEAL_WINDOW_MS] }] },
        { $lte: ["$terminatedAt", "$$NOW"] },
      ],
    },
  };
}

function discordIdentityHash(discordId) {
  return crypto
    .createHmac("sha256", TOMBSTONE_HASH_SECRET)
    .update(String(discordId))
    .digest("hex");
}

function canTerminateUser(actor, target) {
  if (
    target.discordId === OWNER_DISCORD_ID ||
    String(target._id) === String(actor._id)
  ) {
    return false;
  }
  if (actor.role === "owner") return true;
  return actor.role === "manager" && ["user", "moderator"].includes(target.role);
}

function canAssignRole(actor, target, role) {
  if (
    String(target._id) === String(actor._id) ||
    target.discordId === OWNER_DISCORD_ID
  ) {
    return false;
  }
  if (actor.role === "owner") return true;
  return (
    actor.role === "manager" &&
    ["user", "moderator"].includes(target.role) &&
    ["user", "moderator"].includes(role)
  );
}

async function writeAudit(actorId, action, targetId, details = "") {
  await AuditLog.create({ actorId, action, targetId, details });
}

async function purgeExpiredTerminations(now = new Date()) {
  const cutoff = new Date(now.getTime() - APPEAL_WINDOW_MS);
  let purgedCount = 0;
  let expiredAccounts = [];

  do {
    expiredAccounts = await User.find({
      terminated: true,
      terminatedAt: { $lte: cutoff },
    })
      .sort({ terminatedAt: 1 })
      .limit(100)
      .select("_id discordId handle terminatedAt appealUsed appealStatus appealSubmittedAt appealDecisionAt appealDecisionBy")
      .lean();

    for (const account of expiredAccounts) {
      const accountId = new mongoose.Types.ObjectId(account._id);
      const accountIdString = idKey(accountId);
      const tombstone = {
        accountId,
        discordIdHash: discordIdentityHash(account.discordId),
        terminatedAt: account.terminatedAt,
        appealEligible: false,
        appealUsed: Boolean(account.appealUsed),
        appealStatus: account.appealStatus === "pending"
          ? "expired"
          : account.appealStatus || null,
        appealSubmittedAt: account.appealSubmittedAt || null,
        appealDecisionAt: account.appealDecisionAt || null,
        appealDecisionBy: account.appealDecisionBy || null,
        appealWindowExpiredAt: account.appealStatus === "pending" ? now : null,
      };
      if (account.handle) {
        tombstone.normalizedHandle = account.handle.trim().toLowerCase();
      }

      try {
        await AccountTombstone.findOneAndUpdate(
          { accountId },
          { $set: tombstone },
          { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true }
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const concurrentTombstone = await AccountTombstone.findOne({ accountId })
          .select("discordIdHash normalizedHandle")
          .lean();
        if (
          !concurrentTombstone ||
          concurrentTombstone.discordIdHash !== tombstone.discordIdHash ||
          (concurrentTombstone.normalizedHandle || "") !== (tombstone.normalizedHandle || "")
        ) {
          throw error;
        }
      }

      const sessions = await ChirpySession.find({
        $or: [{ userId: accountId }, { terminatedUserId: accountIdString }],
      }).distinct("_id");
      await Promise.all([
        Post.deleteMany({ authorId: accountId }),
        Post.updateMany(
          {
            $or: [
              { likes: accountId },
              { reposts: accountId },
              { bookmarks: accountId },
              { "comments.userId": accountId },
              { "poll.votes.userId": accountId },
            ],
          },
          {
            $pull: {
              likes: accountId,
              reposts: accountId,
              bookmarks: accountId,
              comments: { userId: accountId },
              "poll.votes": { userId: accountId },
            },
          }
        ),
        Follow.deleteMany({
          $or: [{ followerId: accountId }, { followingId: accountId }],
        }),
        Message.deleteMany({
          $or: [{ senderId: accountId }, { recipientId: accountId }],
        }),
        Notification.deleteMany({
          $or: [{ recipientId: accountId }, { actorId: accountId }],
        }),
        PendingRoleAssignment.deleteOne({ discordId: account.discordId }),
        ChirpySession.deleteMany({
          $or: [{ userId: accountId }, { terminatedUserId: accountIdString }],
        }),
        OAuthState.deleteMany({ sessionId: { $in: sessions } }),
      ]);

      const deletion = await User.deleteOne({
        _id: accountId,
        terminated: true,
        terminatedAt: { $lte: cutoff },
      });
      if (deletion.deletedCount) purgedCount += 1;
    }
  } while (expiredAccounts.length === 100);

  if (purgedCount) {
    console.log(`Purged content for ${purgedCount} expired terminated account(s); minimal identity tombstones retained.`);
  }
  return purgedCount;
}

async function syncMentionNotifications(post, actor) {
  const handles = [
    ...new Set(
      [...String(post.text || "").matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,20})/g)]
        .map((match) => match[1].toLowerCase())
    ),
  ];
  const mentionedUsers = handles.length
    ? await User.find({
        handle: { $in: handles },
        terminated: false,
        socialNotificationsEnabled: { $ne: false },
        _id: { $ne: actor._id },
      })
        .select("_id")
        .lean()
    : [];
  const recipientIds = mentionedUsers.map((mentioned) => mentioned._id);
  const notificationScope = { postId: post._id, type: "mention" };
  if (recipientIds.length) {
    await Notification.deleteMany({
      ...notificationScope,
      recipientId: { $nin: recipientIds },
    });
  } else {
    await Notification.deleteMany(notificationScope);
  }
  for (const recipientId of recipientIds) {
    await createSocialNotification({
      recipientId,
      actorId: actor._id,
      type: "mention",
      postId: post._id,
      targetId: post._id,
    });
  }
}

async function createSocialNotification({
  recipientId,
  actorId,
  type,
  postId = null,
  targetId = null,
  eventId = "",
}) {
  if (!recipientId || !actorId || String(recipientId) === String(actorId)) return;
  const recipient = await User.findOne({
    _id: recipientId,
    terminated: false,
    socialNotificationsEnabled: { $ne: false },
  })
    .select("_id")
    .lean();
  if (!recipient) return;

  const eventKey = type === "mention"
    ? `mention:${recipientId}:${postId}`
    : type === "follow"
      ? `follow:${recipientId}:${actorId}`
      : `${type}:${recipientId}:${actorId}:${eventId || postId}`;
  const now = new Date();
  try {
    await Notification.updateOne(
      { eventKey },
      {
        $set: {
          recipientId,
          actorId,
          postId,
          targetId,
          type,
          unread: true,
          createdAt: now,
        },
        $setOnInsert: { eventKey },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    await Notification.updateOne(
      { eventKey },
      { $set: { actorId, targetId, unread: true, createdAt: now } }
    );
  }
}

async function migrateNotificationIndexes() {
  const collectionExists = await mongoose.connection.db
    .listCollections({ name: Notification.collection.name })
    .hasNext();
  if (!collectionExists) await Notification.createCollection();

  const indexes = await Notification.collection.indexes();
  const legacyIndex = indexes.find((index) => index.name === "recipientId_1_postId_1_type_1");
  if (legacyIndex) {
    await Notification.collection.dropIndex(legacyIndex.name);
  }

  const legacyNotifications = Notification.collection.find({
    eventKey: { $exists: false },
  });
  for await (const notification of legacyNotifications) {
    const eventKey = notification.type === "mention"
      ? `mention:${notification.recipientId}:${notification.postId}`
      : `${notification.type || "legacy"}:${notification._id}`;
    await Notification.collection.updateOne(
      { _id: notification._id, eventKey: { $exists: false } },
      { $set: { eventKey } }
    );
  }

  await Notification.collection.createIndex(
    { eventKey: 1 },
    { unique: true, sparse: true, name: "notification_event_key_unique" }
  );
}

async function getMaintenanceSettings() {
  return (
    (await MaintenanceSettings.findById("global").lean()) || {
      enabled: true,
      progress: 2,
      verificationEnabled: true,
    }
  );
}

const requireUser = asyncRoute(async (req, res, next) => {
  const session = await getSession(req);
  if (!session?.userId) {
    const hadSessionCookie = Boolean(readCookie(req, "chirpy_session"));
    const returnTo = req.method === "GET"
      ? safeReturnTo(req.originalUrl)
      : requestReturnTo(req, req.get("Referrer") || "/app");
    const activeSession = session || await getOrCreateSession(req, res);
    activeSession.returnTo = returnTo;
    await saveSession(activeSession);
    if (requestPrefersJson(req)) {
      const loginUrl = `/login?${hadSessionCookie ? "error=session&" : ""}returnTo=${encodeURIComponent(activeSession.returnTo)}`;
      return res
        .status(401)
        .set("X-Chirpy-Login-Url", loginUrl)
        .json({
          success: false,
          message: hadSessionCookie
            ? "Your session expired. Sign in again; this action was not applied."
            : "Please sign in to continue.",
        });
    }
    return res.redirect(`/login?${hadSessionCookie ? "error=session&" : ""}returnTo=${encodeURIComponent(activeSession.returnTo)}`);
  }

  const user = await User.findById(session.userId);
  if (!user) {
    await clearSession(req, res);
    return res.redirect("/login?error=account");
  }
  if (user.terminated) {
    session.userId = null;
    session.terminatedUserId = String(user._id);
    await saveSession(session);
    return res.redirect("/account-terminated");
  }
  await expireMuteIfNeeded(user);
  req.chirpyUser = user;
  const maintenanceSettings = await getMaintenanceSettings();
  if (maintenanceSettings.enabled && !canModerate(user)) {
    return res.redirect("/");
  }
  if (!user.handle) return res.redirect("/onboarding");

  return next();
});

const requireModerator = [
  requireUser,
  (req, res, next) => {
    if (!canModerate(req.chirpyUser)) return sendAppError(req, res, 403, "You do not have permission to access moderation.");
    return next();
  },
];

async function isHandleTaken(handle, exceptUserId) {
  const normalizedHandle = String(handle || "").trim().toLowerCase();
  const escapedHandle = normalizedHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [account, tombstone] = await Promise.all([
    User.exists({
      handle: { $regex: `^${escapedHandle}$`, $options: "i" },
      _id: { $ne: exceptUserId },
    }),
    AccountTombstone.exists({ normalizedHandle }),
  ]);
  return Boolean(account || tombstone);
}

function isDuplicateHandleError(error) {
  return (
    error?.code === 11000 &&
    (error.keyPattern?.handle === 1 || error.keyValue?.handle !== undefined)
  );
}

app.get(
  "/",
  asyncRoute(async (req, res) => {
    const maintenanceSettings = await getMaintenanceSettings();
    const session = await getSession(req);
    if (session?.terminatedUserId) return res.redirect("/account-terminated");
    if (session?.userId) {
      const user = await User.findById(session.userId);
      if (user?.terminated) {
        session.userId = null;
        session.terminatedUserId = String(user._id);
        await saveSession(session);
        return res.redirect("/account-terminated");
      }
      if (user) {
        if (!maintenanceSettings.enabled || canModerate(user)) {
          const destination = user.handle
            ? safeReturnTo(session.returnTo || "/app")
            : "/onboarding";
          if (user.handle) session.returnTo = "/app";
          await saveSession(session);
          return res.redirect(destination === "/" ? "/app" : destination);
        }
      }
    }
    if (maintenanceSettings.enabled) {
      return renderPage(res, "maintenance", { maintenanceSettings });
    }
    return renderPage(res, "landing");
  })
);

app.get("/terms", (req, res) => renderPage(res, "terms"));
app.get("/privacy", (req, res) => renderPage(res, "privacy"));

app.post("/admin/verify", asyncRoute(async (req, res) => {
  if (!safeCompare(req.body.password, ADMIN_PASSWORD)) {
    return res.status(401).json({
      success: false,
      message: "That password is incorrect.",
    });
  }

  const session = await getOrCreateSession(req, res);
  session.adminVerified = true;
  await saveSession(session);
  return res.json({ success: true, redirect: "/login" });
}));

app.get(
  "/login",
  asyncRoute(async (req, res) => {
    const session = await getOrCreateSession(req, res);
    if (req.query.returnTo) session.returnTo = safeReturnTo(String(req.query.returnTo));
    await saveSession(session);
    if (session.terminatedUserId) return res.redirect("/account-terminated");
    if (session?.userId) return res.redirect(safeReturnTo(session.returnTo || "/app"));

    const loginErrors = {
      discord: "Discord sign-in was cancelled or could not be completed. Please try again.",
      config: "Discord sign-in is not configured on this server. Please contact the site operator.",
      state: "Your sign-in session expired or could not be verified. Please try again.",
      session: "Your Chirpy session expired. Sign in again to continue; the last action was not applied.",
      token: "Discord could not complete sign-in. Please try again.",
      profile: "Chirpy could not read your Discord profile. Please try again.",
      account: "This account is unavailable. Contact the site operator if you believe this is an error.",
      purged: "This Discord identity belongs to an account whose data was purged after the 30-day retention period. It cannot create a new Chirpy account.",
    };
    return renderPage(res, "login", {
      error: loginErrors[String(req.query.error || "")] || "",
      returnTo: session.returnTo,
    });
  })
);

app.get(
  "/auth/discord",
  asyncRoute(async (req, res) => {
    const session = await getOrCreateSession(req, res);
    if (req.query.returnTo) session.returnTo = safeReturnTo(String(req.query.returnTo));

    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      return res.redirect(`/login?error=config&returnTo=${encodeURIComponent(session.returnTo || "/app")}`);
    }

    const state = crypto.randomBytes(24).toString("hex");
    session.discordState = state;
    await OAuthState.deleteMany({ sessionId: session._id });
    await OAuthState.create({
      stateHash: crypto.createHash("sha256").update(state).digest("hex"),
      sessionId: session._id,
      returnTo: safeReturnTo(session.returnTo || "/app"),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    await saveSession(session);

    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", DISCORD_CLIENT_ID);
    url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);

    return res.redirect(url.toString());
  })
);

app.get(
  "/auth/discord/callback",
  asyncRoute(async (req, res) => {
    const { code, state, error } = req.query;
    const sessionId = readCookie(req, "chirpy_session");
    const isValidStateShape = typeof state === "string" && /^[a-f0-9]{48}$/.test(state);
    const flow = sessionId && isValidStateShape
      ? await OAuthState.findOneAndDelete({
          stateHash: crypto.createHash("sha256").update(state).digest("hex"),
          sessionId,
          expiresAt: { $gt: new Date() },
        })
      : null;
    if (!flow) {
      const existingSession = await getSession(req);
      const returnTo = safeReturnTo(existingSession?.returnTo || "/app");
      return res.redirect(`/login?error=state&returnTo=${encodeURIComponent(returnTo)}`);
    }
    let session = await getSession(req);
    if (!session) {
      session = {
        _id: sessionId,
        adminVerified: false,
        discordState: null,
        userId: null,
        terminatedUserId: null,
        returnTo: flow.returnTo,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      };
    }
    session.returnTo = safeReturnTo(flow.returnTo || session.returnTo || "/app");
    session.discordState = null;
    await saveSession(session);
    await OAuthState.deleteMany({ sessionId });
    if (error) {
      return res.redirect(`/login?error=discord&returnTo=${encodeURIComponent(session.returnTo)}`);
    }
    if (typeof code !== "string" || !code) {
      return res.redirect(`/login?error=token&returnTo=${encodeURIComponent(session.returnTo)}`);
    }

    let tokenResponse;
    try {
      tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        }),
      });
    } catch (error) {
      console.error("Discord token exchange request failed:", error.message);
      return res.redirect(`/login?error=token&returnTo=${encodeURIComponent(session.returnTo)}`);
    }

    if (!tokenResponse.ok) {
      console.error("Discord token exchange failed:", await tokenResponse.text());
      return res.redirect(`/login?error=token&returnTo=${encodeURIComponent(session.returnTo || "/app")}`);
    }

    let token;
    try {
      token = await tokenResponse.json();
    } catch (error) {
      console.error("Discord token response was invalid:", error.message);
      return res.redirect(`/login?error=token&returnTo=${encodeURIComponent(session.returnTo)}`);
    }

    let profileResponse;
    try {
      profileResponse = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
    } catch (error) {
      console.error("Discord profile request failed:", error.message);
      return res.redirect(`/login?error=profile&returnTo=${encodeURIComponent(session.returnTo)}`);
    }

    if (!profileResponse.ok) {
      return res.redirect(`/login?error=profile&returnTo=${encodeURIComponent(session.returnTo || "/app")}`);
    }

    let profile;
    try {
      profile = await profileResponse.json();
    } catch (error) {
      console.error("Discord profile response was invalid:", error.message);
      return res.redirect(`/login?error=profile&returnTo=${encodeURIComponent(session.returnTo)}`);
    }
    const accountTombstone = await AccountTombstone.exists({
      discordIdHash: discordIdentityHash(profile.id),
    });
    if (accountTombstone) {
      return res.redirect("/login?error=purged");
    }

    const avatar = discordAvatarUrl(profile);

    let user = await User.findOne({ discordId: profile.id });

    if (!user) {
      user = new User({
        discordId: profile.id,
        username: profile.username,
        displayName: profile.global_name || profile.username,
        avatar,
      });
    } else {
      user.username = profile.username;
      user.displayName =
        profile.global_name || user.displayName || profile.username;
      user.avatar = avatar;
    }

    if (user.terminated) {
      await rotateSession(req, res, {
        adminVerified: false,
        userId: null,
        terminatedUserId: String(user._id),
        discordState: null,
        returnTo: "/",
      });
      return res.redirect("/account-terminated");
    }

    const pendingRoleAssignment = await PendingRoleAssignment.findOne({
      discordId: profile.id,
    });
    if (profile.id === OWNER_DISCORD_ID) {
      user.role = "owner";
    } else if (pendingRoleAssignment) {
      user.role = pendingRoleAssignment.role;
    }
    await user.save();
    if (pendingRoleAssignment) await pendingRoleAssignment.deleteOne();

    const returnTo = safeReturnTo(session.returnTo || "/app");
    const maintenanceSettings = await getMaintenanceSettings();
    const blockedByMaintenance = maintenanceSettings.enabled && !canModerate(user);
    await rotateSession(req, res, {
      adminVerified: true,
      userId: user.id,
      terminatedUserId: null,
      discordState: null,
      returnTo,
    });

    if (blockedByMaintenance) return res.redirect("/");
    return res.redirect(user.handle ? returnTo : "/onboarding");
  })
);

app.get(
  "/account-terminated",
  asyncRoute(async (req, res) => {
    const session = await getSession(req);
    if (!session?.terminatedUserId) return res.redirect("/");
    const account = await User.findOne({
      _id: session.terminatedUserId,
      terminated: true,
    })
      .select("displayName terminationReason terminatedAt appealUsed appealStatus appealSubmittedAt appealDecisionAt")
      .lean();
    if (!account) {
      await clearSession(req, res);
      return res.redirect("/");
    }
    const appeal = appealEligibility(account.terminatedAt, account.appealUsed);
    const appealNotice = ({
      tooShort: "Please provide at least 20 characters so staff can understand your appeal.",
      tooLong: "Appeals must be 2,000 characters or fewer.",
      unavailable: "This account is not eligible to submit an appeal. The 30-day period may have expired or an appeal was already used.",
      submitted: "Your appeal has been submitted. It cannot be changed or submitted again.",
    })[String(req.query.appeal || "")] || "";
    return renderPage(res, "terminated", {
      terminatedAccount: {
        displayName: account.displayName || "Chirpy account",
        reason: account.terminationReason || "",
        terminatedAt: account.terminatedAt || null,
        appealUsed: Boolean(account.appealUsed),
        appealStatus: account.appealStatus || "",
        appealSubmittedAt: account.appealSubmittedAt || null,
        appealDecisionAt: account.appealDecisionAt || null,
        appealEligible: appeal.eligible,
        appealClosesAt: appeal.closesAt,
      },
      appealNotice,
    });
  })
);

app.post(
  "/account-terminated/appeal",
  asyncRoute(async (req, res) => {
    const session = await getSession(req);
    if (!session?.terminatedUserId) return res.redirect("/");
    const appealText = String(req.body.appealText || "").trim();
    if (appealText.length < 20) {
      return res.redirect("/account-terminated?appeal=tooShort");
    }
    if (appealText.length > 2000) {
      return res.redirect("/account-terminated?appeal=tooLong");
    }

    const now = new Date();
    const account = await User.findOneAndUpdate(
      {
        _id: session.terminatedUserId,
        terminated: true,
        appealUsed: { $ne: true },
        ...reinstatementWindowFilter(),
      },
      {
        $set: {
          appealUsed: true,
          appealStatus: "pending",
          appealText,
          appealSubmittedAt: now,
          appealDecisionAt: null,
          appealDecisionBy: null,
        },
      },
      { returnDocument: "after", runValidators: true }
    );
    if (!account) {
      return res.redirect("/account-terminated?appeal=unavailable");
    }

    await writeAudit(account._id, "termination_appeal_submitted", account.id);
    return res.redirect("/account-terminated?appeal=submitted");
  })
);

app.get(
  "/onboarding",
  asyncRoute(async (req, res) => {
    const session = await getSession(req);
    const maintenanceSettings = await getMaintenanceSettings();

    const user = session?.userId ? await User.findById(session.userId) : null;
    if (!user) return res.redirect("/login?returnTo=%2Fonboarding");
    if (user.terminated) {
      session.userId = null;
      session.terminatedUserId = String(user._id);
      await saveSession(session);
      return res.redirect("/account-terminated");
    }
    if (maintenanceSettings.enabled && !canModerate(user)) {
      return res.redirect("/");
    }
    if (user.handle) return res.redirect("/app");

    return renderPage(res, "onboarding", { user });
  })
);

app.post(
  "/onboarding",
  asyncRoute(async (req, res) => {
    const session = await getSession(req);
    const maintenanceSettings = await getMaintenanceSettings();
    if (!session?.userId) return res.redirect("/login?returnTo=%2Fonboarding");

    const user = await User.findById(session.userId);
    if (!user) return res.redirect("/login?returnTo=%2Fonboarding");
    if (user.terminated) {
      session.userId = null;
      session.terminatedUserId = String(user._id);
      await saveSession(session);
      return res.redirect("/account-terminated");
    }
    if (maintenanceSettings.enabled && !canModerate(user)) {
      return res.redirect("/");
    }

    const handle = String(req.body.handle || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    const displayName =
      String(req.body.displayName || "").trim().slice(0, 40) ||
      user.displayName ||
      user.username;

    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      return renderPage(res, "onboarding", {
        user,
        handle,
        displayName,
        error: "Use 3–20 characters: lowercase letters, numbers, or underscores.",
      });
    }

    if (await isHandleTaken(handle, user._id)) {
      return renderPage(res, "onboarding", {
        user,
        handle,
        displayName,
        error: "That handle is already taken. Try another one.",
      });
    }

    user.handle = handle;
    user.displayName = displayName;
    user.handleChangedAt = new Date();
    try {
      await user.save();
    } catch (error) {
      if (!isDuplicateHandleError(error)) throw error;
      return renderPage(res, "onboarding", {
        user,
        handle,
        displayName,
        error: "That handle is already taken. Try another one.",
      });
    }

    const destination = safeReturnTo(session.returnTo || "/app");
    session.returnTo = "/app";
    await saveSession(session);
    return res.redirect(destination === "/onboarding" || destination === "/" ? "/app" : destination);
  })
);

app.get(
  "/app",
  requireUser,
  asyncRoute(async (req, res) => {
    const allowedTabs = [
      "home",
      "explore",
      "messages",
      "notifications",
      "bookmarks",
      "profile",
      "settings",
      "banland",
      "moderation",
      "logs",
    ];
    const requestedTab = typeof req.query.tab === "string" ? req.query.tab : "home";
    const activeTab = allowedTabs.includes(requestedTab)
      ? requestedTab
      : "home";
    const profileView =
      req.query.profileView === "reposts" ? "reposts" : "posts";
    const query = String(req.query.q || "").trim().slice(0, 80);
    const muteQuery = String(req.query.muteQ || "").trim().slice(0, 80);
    const banlandQuery = String(req.query.banQ || "").trim().slice(0, 80);
    const logQuery = String(req.query.logQ || "").trim().slice(0, 80);
    const requestedLogPage = Number(req.query.logPage || 1);
    let logPage = Number.isInteger(requestedLogPage) && requestedLogPage > 0
      ? Math.min(requestedLogPage, 1000)
      : 1;
    const user = req.chirpyUser;
    const maintenanceSettings = await getMaintenanceSettings();
    const muteInfo = userIsMuted(user)
      ? { until: user.mutedUntil, reason: user.mutedReason || "" }
      : null;

    if (["moderation", "logs"].includes(activeTab) && !canModerate(user)) {
      return res.redirect("/app?tab=home");
    }
    if (activeTab === "banland" && !canManageStaff(user)) {
      return res.redirect("/app?tab=moderation");
    }
    if (activeTab === "banland") await purgeExpiredTerminations();
    let terminatedUserIds = [];
    if (["home", "explore", "bookmarks", "profile"].includes(activeTab)) {
      terminatedUserIds = await User.find({ terminated: true }).distinct("_id");
    }

    let postQuery = { deleted: false };
    if (terminatedUserIds.length) {
      postQuery.$and = [{ authorId: { $nin: terminatedUserIds } }];
    }
    if (activeTab === "bookmarks") {
      postQuery.bookmarks = user._id;
    } else if (activeTab === "profile" && profileView === "reposts") {
      postQuery.reposts = user._id;
    } else if (activeTab === "profile") {
      postQuery.authorId = user._id;
    } else if (activeTab === "explore" && query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matchingUsers = await User.find({
        handle: { $regex: escaped, $options: "i" },
        terminated: false,
      }).select("_id");
      postQuery.$or = [
        { text: { $regex: escaped, $options: "i" } },
        { authorId: { $in: matchingUsers.map((entry) => entry._id) } },
      ];
    }

    const posts = activeTab === "messages" || activeTab === "notifications" || activeTab === "settings" || activeTab === "moderation" || activeTab === "banland" || activeTab === "logs"
      ? []
      : await Post.find(postQuery)
          .select("-imageData")
          .sort({ createdAt: -1 })
          .limit(100)
          .lean();

    const authorIds = new Map();
    for (const post of posts) {
      authorIds.set(idKey(post.authorId).toLowerCase(), post.authorId);
      for (const comment of post.comments || []) {
        authorIds.set(idKey(comment.userId).toLowerCase(), comment.userId);
      }
    }

    const postUsers = authorIds.size
      ? await User.find({ _id: { $in: [...authorIds.values()] } })
          .select(
            "_id discordId username handle displayName avatar role partner verificationStatus muted mutedUntil mutedReason mutedBy"
          )
          .lean()
      : [];

    const userMap = Object.create(null);
    for (const entry of postUsers) {
      userMap[idKey(entry._id).toLowerCase()] = entry;
    }
    for (const post of posts) {
      post.author = userMap[idKey(post.authorId).toLowerCase()] || null;
    }

    const messages =
      activeTab === "messages"
        ? await Message.find({
            $or: [{ senderId: user._id }, { recipientId: user._id }],
          })
            .sort({ createdAt: 1 })
            .limit(200)
            .lean()
        : [];
    const notifications =
      activeTab === "notifications"
        ? await Notification.find({ recipientId: user._id })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean()
        : [];
    if (activeTab === "notifications" && notifications.some((notification) => notification.unread)) {
      await Notification.updateMany(
        { recipientId: user._id, unread: true },
        { $set: { unread: false } }
      );
      notifications.forEach((notification) => { notification.unread = false; });
    }
    const notificationActorIds = [...new Set(notifications.map((notification) => idKey(notification.actorId)).filter(Boolean))];
    const notificationActors = notificationActorIds.length
      ? await User.find({ _id: { $in: notificationActorIds }, terminated: false })
          .select("_id displayName username handle avatar role partner verificationStatus")
          .lean()
      : [];
    const notificationActorMap = Object.fromEntries(
      notificationActors.map((actor) => [idKey(actor._id), actor])
    );
    const unreadNotificationCount = await Notification.countDocuments({
      recipientId: user._id,
      unread: true,
    });
    const verificationOutcomeNotice = await VerificationOutcomeNotice.findOne({
      recipientId: user._id,
      acknowledgedAt: null,
    })
      .sort({ createdAt: 1 })
      .lean();

    if (activeTab === "moderation" && canModerate(user)) {
      await User.updateMany(
        { muted: true, mutedUntil: { $ne: null, $lte: new Date() } },
        { $set: { muted: false, mutedUntil: null, mutedReason: "", mutedBy: null } }
      );
    }
    const staffUsers =
      activeTab === "moderation" && canModerate(user)
        ? await User.find({ _id: { $ne: user._id } })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean()
        : [];
    const escapedMuteQuery = muteQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const muteSearchCondition = muteQuery
      ? {
          $or: [
            { displayName: { $regex: escapedMuteQuery, $options: "i" } },
            { username: { $regex: escapedMuteQuery, $options: "i" } },
            { handle: { $regex: escapedMuteQuery, $options: "i" } },
            { discordId: { $regex: escapedMuteQuery } },
          ],
        }
      : {};
    const activeMutes =
      activeTab === "moderation" && canModerate(user)
        ? await User.find({
            muted: true,
            terminated: false,
            ...(muteQuery ? { $and: [muteSearchCondition] } : {}),
            $or: [{ mutedUntil: null }, { mutedUntil: { $gt: new Date() } }],
          })
            .sort({ mutedUntil: 1, updatedAt: -1 })
            .limit(200)
            .lean()
        : [];
    const muteActorIds = [...new Set(activeMutes.map((account) => idKey(account.mutedBy)).filter(Boolean))];
    const muteActors = muteActorIds.length
      ? await User.find({ _id: { $in: muteActorIds } })
          .select("_id displayName username")
          .lean()
      : [];
    const muteActorMap = Object.fromEntries(muteActors.map((actor) => [idKey(actor._id), actor]));
    const escapedBanQuery = banlandQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const banlandSearchCondition = banlandQuery
      ? {
          $or: [
            { displayName: { $regex: escapedBanQuery, $options: "i" } },
            { username: { $regex: escapedBanQuery, $options: "i" } },
            { handle: { $regex: escapedBanQuery, $options: "i" } },
            { discordId: { $regex: escapedBanQuery } },
            { terminationReason: { $regex: escapedBanQuery, $options: "i" } },
          ],
        }
      : {};
    const activeTerminatedUsers =
      activeTab === "banland" && canManageStaff(user)
        ? await User.find({ ...banlandSearchCondition, terminated: true })
            .sort({ terminatedAt: -1, updatedAt: -1 })
            .limit(200)
            .lean()
        : [];
    const cutoffDate = new Date(Date.now() - APPEAL_WINDOW_MS);
    const expiredTombstoneFilter = { terminatedAt: { $lte: cutoffDate } };
    if (banlandQuery) {
      const tombstoneSearch = [
        { normalizedHandle: { $regex: escapedBanQuery, $options: "i" } },
      ];
      if (mongoose.isValidObjectId(banlandQuery)) {
        tombstoneSearch.push({ accountId: new mongoose.Types.ObjectId(banlandQuery) });
      }
      expiredTombstoneFilter.$or = tombstoneSearch;
    }
    const purgedTombstones =
      activeTab === "banland" && canManageStaff(user)
        ? await AccountTombstone.find(expiredTombstoneFilter)
            .sort({ terminatedAt: -1 })
            .limit(200)
            .lean()
        : [];
    const terminatedUsers = [
      ...activeTerminatedUsers.map((account) => {
        const canReinstate = withinReinstatementWindow(account.terminatedAt);
        return {
          ...account,
          appealStatus: account.appealStatus === "pending" && !canReinstate
            ? "expired"
            : account.appealStatus,
          dataPurged: false,
          canReinstate,
          reinstatementExpired: Boolean(account.terminatedAt) && !canReinstate,
        };
      }),
      ...purgedTombstones.map((record) => ({
        _id: idKey(record.accountId),
        displayName: "Purged account",
        username: "",
        handle: record.normalizedHandle || "",
        discordId: "",
        terminated: true,
        terminationReason: "",
        terminatedAt: record.terminatedAt,
        terminatedBy: null,
        appealUsed: record.appealUsed,
        appealStatus: record.appealStatus || "",
        appealSubmittedAt: record.appealSubmittedAt,
        appealDecisionAt: record.appealDecisionAt,
        appealEligible: false,
        dataPurged: true,
        canReinstate: false,
        reinstatementExpired: true,
      })),
    ].sort((left, right) =>
      new Date(right.terminatedAt || 0).getTime() - new Date(left.terminatedAt || 0).getTime()
    );
    const applications =
      activeTab === "moderation" && canModerate(user)
        ? await User.find({
            verificationStatus: "pending",
            terminated: false,
          })
            .sort({ verificationAppliedAt: 1 })
            .limit(100)
            .lean()
        : [];
    const pendingAppeals =
      activeTab === "moderation" && canModerate(user)
        ? await User.find({
            terminated: true,
            appealUsed: true,
            appealStatus: "pending",
            ...reinstatementWindowFilter(),
          })
            .sort({ appealSubmittedAt: 1 })
            .limit(100)
            .select("_id displayName username handle discordId appealText appealSubmittedAt terminatedAt terminationReason")
            .lean()
        : [];
    const verifiedUsers =
      activeTab === "moderation" && canManageStaff(user)
        ? await User.find({
            verificationStatus: "verified",
            role: "user",
            terminated: false,
          })
            .sort({ verificationAppliedAt: -1, updatedAt: -1 })
            .limit(200)
            .lean()
        : [];
    const pendingRoleAssignments =
      activeTab === "moderation" && canManageStaff(user)
        ? await PendingRoleAssignment.find(
            user.role === "owner" ? {} : { role: "moderator" }
          )
            .sort({ updatedAt: -1 })
            .limit(100)
            .lean()
        : [];
    const roleAssignmentUsers =
      pendingRoleAssignments.length > 0
        ? await User.find({
            discordId: {
              $in: pendingRoleAssignments.map((assignment) => assignment.discordId),
            },
          })
            .select("discordId username displayName handle avatar")
            .lean()
        : [];
    const roleAssignmentUserMap = Object.fromEntries(
      roleAssignmentUsers.map((account) => [account.discordId, account])
    );
    const terminationActorIds = [
      ...new Set(
        terminatedUsers
          .map((account) => idKey(account.terminatedBy))
          .filter(Boolean)
      ),
    ];
    const terminationActors = terminationActorIds.length
      ? await User.find({ _id: { $in: terminationActorIds } })
          .select("_id displayName username handle")
          .lean()
      : [];
    const terminationActorMap = Object.fromEntries(
      terminationActors.map((actor) => [idKey(actor._id), actor])
    );

    let auditLogs = [];
    let auditActorMap = {};
    let auditTargetMap = {};
    let auditTotalPages = 1;
    if (activeTab === "logs" && canModerate(user)) {
      const escapedLogQuery = logQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const logRegex = logQuery ? new RegExp(escapedLogQuery, "i") : null;
      let logSearchUserIds = [];
      let logSearchDiscordIds = [];
      if (logRegex) {
        const matchingUsers = await User.find({
          $or: [
            { displayName: logRegex },
            { username: logRegex },
            { handle: logRegex },
            { discordId: logRegex },
          ],
        })
          .select("_id discordId")
          .limit(500)
          .lean();
        logSearchUserIds = matchingUsers.map((account) => account._id);
        logSearchDiscordIds = matchingUsers.map((account) => account.discordId);
        const tombstoneSearch = [
          { normalizedHandle: logRegex },
        ];
        if (mongoose.isValidObjectId(logQuery)) {
          tombstoneSearch.push({ accountId: new mongoose.Types.ObjectId(logQuery) });
        }
        const matchingTombstones = await AccountTombstone.find({ $or: tombstoneSearch })
          .select("accountId")
          .limit(500)
          .lean();
        logSearchUserIds.push(...matchingTombstones.map((record) => record.accountId));
      }
      const logFilter = logRegex
        ? {
            $or: [
              { action: logRegex },
              { details: logRegex },
              { targetId: logRegex },
              ...(logSearchUserIds.length ? [{ actorId: { $in: logSearchUserIds } }] : []),
              ...(logSearchUserIds.length || logSearchDiscordIds.length
                ? [{
                    targetId: {
                      $in: [...logSearchUserIds.map((id) => idKey(id)), ...logSearchDiscordIds],
                    },
                  }]
                : []),
            ],
          }
        : {};
      const logLimit = 50;
      const logCount = await AuditLog.countDocuments(logFilter);
      auditTotalPages = Math.max(1, Math.ceil(logCount / logLimit));
      logPage = Math.min(logPage, auditTotalPages);
      auditLogs = await AuditLog.find(logFilter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((logPage - 1) * logLimit)
        .limit(logLimit)
        .lean();
      const logUserIds = [...new Set(auditLogs.flatMap((entry) => [
        idKey(entry.actorId),
        mongoose.isValidObjectId(entry.targetId) ? entry.targetId : "",
      ]).filter(Boolean))];
      const logUsers = logUserIds.length
        ? await User.find({ _id: { $in: logUserIds } })
            .select("_id discordId displayName username handle")
            .lean()
        : [];
      auditActorMap = Object.fromEntries(
        logUsers.map((account) => [idKey(account._id), account])
      );
      auditTargetMap = { ...auditActorMap };
      const purgedLogAccounts = logUserIds.length
        ? await AccountTombstone.find({ accountId: { $in: logUserIds } })
            .select("accountId normalizedHandle")
            .lean()
        : [];
      for (const record of purgedLogAccounts) {
        const tombstoneActor = {
          _id: idKey(record.accountId),
          displayName: "Purged account",
          username: "",
          handle: record.normalizedHandle || "",
        };
        auditActorMap[idKey(record.accountId)] = tombstoneActor;
        auditTargetMap[idKey(record.accountId)] = tombstoneActor;
      }
      const pendingTargets = auditLogs
        .filter((entry) => !mongoose.isValidObjectId(entry.targetId))
        .map((entry) => entry.targetId)
        .filter((value) => /^\d{17,20}$/.test(value));
      if (pendingTargets.length) {
        const pendingTargetUsers = await User.find({ discordId: { $in: pendingTargets } })
          .select("_id discordId displayName username handle")
          .lean();
        for (const account of pendingTargetUsers) {
          auditTargetMap[account.discordId] = account;
        }
      }
      for (const entry of auditLogs) {
        const actor = auditActorMap[idKey(entry.actorId)];
        const target = auditTargetMap[entry.targetId];
        if (logRegex && ![
          entry.action,
          entry.details,
          entry.targetId,
          actor?.displayName,
          actor?.username,
          actor?.handle,
          actor?.discordId,
          target?.displayName,
          target?.username,
          target?.handle,
          target?.discordId,
        ].some((value) => String(value || "").toLowerCase().includes(logQuery.toLowerCase()))) {
          entry.filteredOutByIdentity = true;
        }
      }
      if (logRegex) auditLogs = auditLogs.filter((entry) => !entry.filteredOutByIdentity);
    }

    const messageUserIds = [
      ...new Set(
        messages.flatMap((message) => [
          String(message.senderId),
          String(message.recipientId),
        ])
      ),
    ];
    const messageUsers = await User.find({
      _id: { $in: messageUserIds },
    }).select("handle displayName");
    const messageUserMap = Object.fromEntries(
      messageUsers.map((entry) => [String(entry._id), entry])
    );

    const ownProfileStats = activeTab === "profile"
      ? await Promise.all([
          Follow.countDocuments({ followingId: user._id }),
          Follow.countDocuments({ followerId: user._id }),
          Post.aggregate([
            { $match: { authorId: user._id, deleted: false } },
            {
              $group: {
                _id: null,
                postCount: { $sum: 1 },
                likesReceived: {
                  $sum: { $size: { $ifNull: ["$likes", []] } },
                },
              },
            },
          ]),
        ])
      : [0, 0, []];
    const ownProfilePostCount = ownProfileStats[2][0]?.postCount || 0;
    const ownProfileLikesReceived = ownProfileStats[2][0]?.likesReceived || 0;

    const nextHandleChange = handleChangeAvailableAt(user);
    const handleChangeAllowed =
      !nextHandleChange || nextHandleChange.getTime() <= Date.now();

    const handleErrors = {
      cooldown: "Your handle is on a 14-day cooldown.",
      taken: "That handle is already taken. Try another one.",
      invalid: "Use 3–20 characters: lowercase letters, numbers, or underscores.",
    };

    return renderPage(res, "app", {
      user,
      activeTab,
      profileView,
      followersCount: ownProfileStats[0],
      followingCount: ownProfileStats[1],
      postCount: ownProfilePostCount,
      likesReceived: ownProfileLikesReceived,
      query,
      saved: req.query.saved === "1",
      handleError: handleErrors[String(req.query.handleError || "")] || "",
      handleChangeAvailableAt: nextHandleChange,
      handleChangeAllowed,
      posts,
      userMap,
      messages,
      messageUserMap,
      notifications,
      notificationActorMap,
      unreadNotificationCount,
      staffUsers,
      terminatedUsers,
      terminationActorMap,
      auditLogs,
      auditActorMap,
      auditTargetMap,
      auditTotalPages,
      logPage,
      logQuery,
      pendingAppeals,
      muteQuery,
      banlandQuery,
      applications,
      verifiedUsers,
      pendingRoleAssignments,
      roleAssignmentUserMap,
      maintenanceSettings,
      muteInfo,
      activeMutes,
      muteActorMap,
      notice: ({
        saved: "Your changes have been saved.",
        notificationsSaved: "Your notification preference has been saved.",
        partnerUpdated: "The partner badge assignment was updated.",
        partnerUnchanged: "That account already has the selected partner badge status.",
        muted: "Your account is currently muted. You can browse, but posting and interactions are disabled.",
        appealAccepted: "The appeal was accepted and the account has been reinstated.",
        appealDenied: "The appeal was denied.",
        verificationSettingSaved: "Verification application availability was updated.",
        action: "That action could not be completed. Check your access and try again.",
        muteSaved: "The mute settings were updated.",
        unmuted: "The account was unmuted.",
      })[String(req.query.notice || "")] || "",
      verificationNotice: ({
        alreadyVerified: "Your account is already verified.",
        pending: "You already have an application awaiting review.",
        cooldown: "You can submit another application after the seven-day cooldown.",
        disabled: "Verification applications are currently paused by site staff.",
      })[String(req.query.verification || "")] || "",
      verificationOutcomeNotice,
      verificationApplicationAvailable: verificationApplicationAvailable(
        user.verificationLastAppliedAt || user.verificationAppliedAt
      ),
      verificationApplicationAvailableAt: (() => {
        const lastAppliedAt = user.verificationLastAppliedAt || user.verificationAppliedAt;
        const appliedAt = lastAppliedAt ? new Date(lastAppliedAt).getTime() : NaN;
        return Number.isFinite(appliedAt)
          ? new Date(appliedAt + VERIFICATION_APPLICATION_COOLDOWN_MS)
          : null;
      })(),
    });
  })
);

app.get(
  "/profile/:handle",
  asyncRoute(async (req, res) => {
    const maintenanceSettings = await getMaintenanceSettings();
    if (maintenanceSettings.enabled) {
      return renderPage(res, "maintenance", { maintenanceSettings });
    }

    const handle = String(req.params.handle || "").replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) return sendAppError(req, res, 404, "That profile could not be found.");
    const profileAccount = await User.findOne({
      handle,
      terminated: false,
    }).lean();
    if (!profileAccount) return sendAppError(req, res, 404, "That profile could not be found.");

    const profileView = req.query.view === "reposts" ? "reposts" : "posts";
    const postQuery = profileView === "reposts"
      ? { reposts: profileAccount._id, deleted: false }
      : { authorId: profileAccount._id, deleted: false };
    const profilePosts = await Post.find({
      ...postQuery,
    })
      .select("-imageData")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const profileAuthorIds = [...new Set(profilePosts.map((post) => idKey(post.authorId)))];
    const profileAuthors = profileAuthorIds.length
      ? await User.find({ _id: { $in: profileAuthorIds }, terminated: false })
          .select("_id discordId username handle displayName avatar role partner verificationStatus")
          .lean()
      : [];
    const profileAuthorMap = Object.fromEntries(
      profileAuthors.map((author) => [idKey(author._id), author])
    );
    const visibleProfilePosts = profilePosts.filter((post) => {
      post.author = profileAuthorMap[idKey(post.authorId)] || null;
      return Boolean(post.author);
    });

    const [followersCount, followingCount, postStats, session] = await Promise.all([
      Follow.countDocuments({ followingId: profileAccount._id }),
      Follow.countDocuments({ followerId: profileAccount._id }),
      Post.aggregate([
        { $match: { authorId: profileAccount._id, deleted: false } },
        {
          $group: {
            _id: null,
            postCount: { $sum: 1 },
            likesReceived: {
              $sum: { $size: { $ifNull: ["$likes", []] } },
            },
          },
        },
      ]),
      getSession(req),
    ]);
    const viewer = session?.userId
      ? await User.findOne({ _id: session.userId, terminated: false })
          .select("_id")
          .lean()
      : null;
    const isFollowing = viewer
      ? Boolean(await Follow.exists({
          followerId: viewer._id,
          followingId: profileAccount._id,
        }))
      : false;
    return renderPage(res, "public-profile", {
      profileAccount,
      profilePosts: visibleProfilePosts,
      profileAuthorMap,
      profileView,
      viewer,
      isFollowing,
      followersCount,
      followingCount,
      postCount: postStats[0]?.postCount || 0,
      likesReceived: postStats[0]?.likesReceived || 0,
      profileNotice: req.query.notice === "followed"
        ? "You are now following this profile."
        : req.query.notice === "unfollowed"
          ? "You unfollowed this profile."
          : "",
      maintenanceSettings,
    });
  })
);

app.post(
  "/profile/:handle/follow",
  requireUser,
  asyncRoute(async (req, res) => {
    if (userIsMuted(req.chirpyUser)) return mutedResponse(req, res);
    const handle = String(req.params.handle || "").replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      return sendAppError(req, res, 404, "That profile could not be found.");
    }
    const target = await User.findOne({ handle, terminated: false }).select("_id handle");
    if (!target) return sendAppError(req, res, 404, "That profile could not be found.");
    if (String(target._id) === String(req.chirpyUser._id)) {
      return sendAppError(req, res, 400, "You cannot follow your own profile.");
    }
    const shouldFollow = req.body.follow;
    if (shouldFollow !== true && shouldFollow !== false && shouldFollow !== "true" && shouldFollow !== "false") {
      return sendAppError(req, res, 400, "Choose whether to follow or unfollow this profile.");
    }
    if (shouldFollow === true || shouldFollow === "true") {
      let createdFollow = false;
      try {
        const followResult = await Follow.updateOne(
          { followerId: req.chirpyUser._id, followingId: target._id },
          { $setOnInsert: { followerId: req.chirpyUser._id, followingId: target._id } },
          { upsert: true, setDefaultsOnInsert: true }
        );
        createdFollow = followResult.upsertedCount > 0;
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
      const [activeActor, activeTarget] = await Promise.all([
        User.exists({ _id: req.chirpyUser._id, terminated: false }),
        User.exists({ _id: target._id, terminated: false }),
      ]);
      if (!activeActor || !activeTarget) {
        await Follow.deleteOne({
          followerId: req.chirpyUser._id,
          followingId: target._id,
        });
        return sendAppError(req, res, 404, "That profile is no longer available.");
      }
      if (createdFollow) {
        await createSocialNotification({
          recipientId: target._id,
          actorId: req.chirpyUser._id,
          type: "follow",
          targetId: req.chirpyUser._id,
        });
      }
    } else {
      await Follow.deleteOne({
        followerId: req.chirpyUser._id,
        followingId: target._id,
      });
    }

    if (requestPrefersJson(req)) {
      return res.json({
        success: true,
        following: shouldFollow === true || shouldFollow === "true",
        followersCount: await Follow.countDocuments({ followingId: target._id }),
      });
    }
    const notice = shouldFollow === true || shouldFollow === "true" ? "followed" : "unfollowed";
    return res.redirect(`/profile/${encodeURIComponent(target.handle)}?notice=${notice}`);
  })
);

app.post(
  "/posts",
  requireUser,
  asyncRoute(async (req, res) => {
    if (userIsMuted(req.chirpyUser)) return mutedResponse(req, res);

    const text = String(req.body.text || "").trim().slice(0, 500);
    if (req.body.imageUrl) {
      return res.status(400).json({
        success: false,
        message: "Upload an image file instead of submitting an image URL.",
      });
    }
    const image = req.body.imageData
      ? parseUploadedImage(req.body.imageData)
      : null;
    if (req.body.imageData && !image) {
      return res.status(400).json({
        success: false,
        message: "Choose a valid PNG, JPEG, GIF, or WebP image up to 5 MB.",
      });
    }

    let poll = null;
    if (req.body.poll !== undefined && req.body.poll !== null) {
      const pollInput = req.body.poll;
      if (
        typeof pollInput !== "object" ||
        Array.isArray(pollInput) ||
        typeof pollInput.question !== "string" ||
        !Array.isArray(pollInput.options)
      ) {
        return res.status(400).json({
          success: false,
          message: "Add a poll question and between two and four options.",
        });
      }
      const question = pollInput.question.trim().slice(0, 180);
      const options = pollInput.options
        .filter((option) => typeof option === "string")
        .map((option) => option.trim().slice(0, 80))
        .filter(Boolean);
      if (!question || options.length < 2 || options.length > 4) {
        return res.status(400).json({
          success: false,
          message: "A poll needs a question and between two and four non-empty options.",
        });
      }
      poll = { question, options: options.map((option) => ({ text: option })), votes: [] };
    }

    if (!text && !image && !poll) {
      return res.status(400).json({
        success: false,
        message: "Write a post, choose an image, or add a poll.",
      });
    }

    const post = await Post.create({
      authorId: req.chirpyUser._id,
      text,
      imageData: image ? image.bytes : null,
      imageMime: image ? image.mime : null,
      poll,
    });
    await syncMentionNotifications(post, req.chirpyUser);

    return res.json({ success: true, redirect: "/app" });
  })
);

app.get(
  "/posts/:id/image",
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).end();
    }
    const post = await Post.findOne({
      _id: req.params.id,
      deleted: false,
    }).select("imageData imageMime");
    const bytes = post?.imageData ? Buffer.from(post.imageData) : null;
    if (
      !post ||
      !bytes?.length ||
      bytes.length > 5 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(post.imageMime) ||
      sniffImageMime(bytes) !== post.imageMime
    ) {
      return res.status(404).end();
    }

    res.set({
      "Cache-Control": "public, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(bytes.length),
      "Content-Type": post.imageMime,
    });
    return res.end(bytes);
  })
);

app.post(
  "/posts/:id/delete",
  requireUser,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }
    const post = await Post.findOne({
      _id: req.params.id,
      authorId: req.chirpyUser._id,
      deleted: false,
    });
    if (!post) {
      return res.status(404).json({ success: false, message: "That post is unavailable or does not belong to you." });
    }
    post.deleted = true;
    await post.save();
    await Notification.deleteMany({ postId: post._id });
    await writeAudit(req.chirpyUser._id, "own_post_deleted", post.id);
    return res.redirect(requestReturnTo(req, req.get("Referrer") || "/app"));
  })
);

app.post(
  "/posts/:id/edit",
  requireUser,
  asyncRoute(async (req, res) => {
    if (userIsMuted(req.chirpyUser)) return mutedResponse(req, res);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }
    if (typeof req.body.text !== "string") {
      return res.status(400).json({ success: false, message: "Post text is required." });
    }
    const post = await Post.findOne({
      _id: req.params.id,
      authorId: req.chirpyUser._id,
      deleted: false,
    });
    if (!post) {
      return res.status(404).json({ success: false, message: "That post is unavailable or does not belong to you." });
    }
    const text = req.body.text.trim().slice(0, 500);
    if (!text && !post.imageMime && !post.poll) {
      return res.status(400).json({ success: false, message: "A post must contain text, an image, or a poll." });
    }
    post.text = text;
    await post.save();
    await syncMentionNotifications(post, req.chirpyUser);
    await writeAudit(req.chirpyUser._id, "own_post_edited", post.id);
    return res.json({ success: true });
  })
);

app.post(
  "/posts/:id/poll",
  requireUser,
  asyncRoute(async (req, res) => {
    if (userIsMuted(req.chirpyUser)) return mutedResponse(req, res);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    const rawOptionIndex = req.body.optionIndex;
    const optionIndex =
      typeof rawOptionIndex === "number"
        ? rawOptionIndex
        : typeof rawOptionIndex === "string" && /^\d+$/.test(rawOptionIndex)
          ? Number(rawOptionIndex)
          : Number.NaN;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) {
      return res.status(400).json({ success: false, message: "Choose a poll option." });
    }

    const postId = new mongoose.Types.ObjectId(req.params.id);
    const postBeforeVote = await Post.findOne({
      _id: postId,
      deleted: false,
    }).select("poll.options");
    if (
      !postBeforeVote ||
      !postBeforeVote.poll ||
      optionIndex >= postBeforeVote.poll.options.length
    ) {
      return res.status(404).json({ success: false, message: "Poll not found." });
    }

    const userId = new mongoose.Types.ObjectId(String(req.chirpyUser._id));
    const update = await Post.updateOne(
      { _id: postId, deleted: false, "poll.options": { $exists: true } },
      [
        {
          $set: {
            "poll.votes": {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ["$poll.votes", []] },
                    as: "vote",
                    cond: { $ne: ["$$vote.userId", userId] },
                  },
                },
                [{ $literal: { userId, optionIndex } }],
              ],
            },
          },
        },
      ],
      { updatePipeline: true }
    );
    if (!update.matchedCount) {
      return res.status(404).json({ success: false, message: "Poll not found." });
    }

    const updatedPost = await Post.findById(postId).select("poll").lean();
    if (!updatedPost || !updatedPost.poll) {
      return res.status(404).json({ success: false, message: "Poll not found." });
    }
    const counts = updatedPost.poll.options.map(
      (_, index) =>
        (updatedPost.poll.votes || []).filter(
          (vote) => vote.optionIndex === index
        ).length
    );
    return res.json({ success: true, counts, optionIndex });
  })
);

app.post(
  "/posts/:id/:action",
  requireUser,
  asyncRoute(async (req, res, next) => {
    if (req.params.action === "comments") return next();
    if (userIsMuted(req.chirpyUser)) return mutedResponse(req, res);

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    const collectionNames = {
      like: "likes",
      repost: "reposts",
      bookmark: "bookmarks",
    };
    const field = collectionNames[req.params.action];
    if (!field) {
      return res.status(400).json({ success: false, message: "Unknown action." });
    }

    const post = await Post.findOne({ _id: req.params.id, deleted: false });
    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    const userId = req.chirpyUser._id;
    const existing = post[field].some((id) => String(id) === String(userId));
    if (existing) {
      post[field] = post[field].filter((id) => String(id) !== String(userId));
    } else {
      post[field].push(userId);
    }

    await post.save();
    if (!existing && ["like", "repost"].includes(req.params.action)) {
      await createSocialNotification({
        recipientId: post.authorId,
        actorId: req.chirpyUser._id,
        type: req.params.action,
        postId: post._id,
        targetId: post._id,
      });
    }
    return res.json({
      success: true,
      active: !existing,
      count: post[field].length,
    });
  })
);

app.post(
  "/posts/:id/comments",
  requireUser,
  asyncRoute(async (req, res) => {
    if (userIsMuted(req.chirpyUser)) return mutedResponse(req, res);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    const text = String(req.body.text || "").trim().slice(0, 300);
    if (!text) {
      return res.status(400).json({ success: false, message: "Write a comment first." });
    }

    const post = await Post.findOne({ _id: req.params.id, deleted: false });
    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    post.comments.push({
      userId: req.chirpyUser._id,
      handle: req.chirpyUser.handle,
      text,
    });
    const comment = post.comments[post.comments.length - 1];
    await post.save();
    await createSocialNotification({
      recipientId: post.authorId,
      actorId: req.chirpyUser._id,
      type: "comment",
      postId: post._id,
      targetId: post._id,
      eventId: comment._id,
    });

    return res.json({
      success: true,
      comment: { handle: req.chirpyUser.handle, text },
      count: post.comments.length,
    });
  })
);

app.post(
  "/messages",
  requireUser,
  asyncRoute(async (req, res) => {
    if (userIsMuted(req.chirpyUser)) return mutedResponse(req, res);

    const recipientHandle = String(req.body.handle || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    const text = String(req.body.text || "").trim().slice(0, 1000);
    const recipient = await User.findOne({
      handle: recipientHandle,
      terminated: false,
    });

    if (!recipient || String(recipient._id) === String(req.chirpyUser._id) || !text) {
      return res.redirect("/app?tab=messages");
    }

    const message = await Message.create({
      senderId: req.chirpyUser._id,
      recipientId: recipient._id,
      text,
    });
    await createSocialNotification({
      recipientId: recipient._id,
      actorId: req.chirpyUser._id,
      type: "message",
      targetId: message._id,
      eventId: message._id,
    });

    return res.redirect("/app?tab=messages");
  })
);

app.post(
  "/settings",
  requireUser,
  asyncRoute(async (req, res) => {
    req.chirpyUser.displayName =
      String(req.body.displayName || "").trim().slice(0, 40) ||
      req.chirpyUser.displayName;
    req.chirpyUser.bio = String(req.body.bio || "").trim().slice(0, 160);
    await req.chirpyUser.save();

    return res.redirect("/app?tab=settings&saved=1");
  })
);

app.post(
  "/settings/notifications",
  requireUser,
  asyncRoute(async (req, res) => {
    const enabled = String(req.body.enabled || "");
    if (!["true", "false"].includes(enabled)) {
      return sendAppError(req, res, 400, "Choose whether social notifications are enabled.");
    }
    req.chirpyUser.socialNotificationsEnabled = enabled === "true";
    await req.chirpyUser.save();
    return res.redirect("/app?tab=settings&notice=notificationsSaved");
  })
);

app.post(
  "/settings/handle",
  requireUser,
  asyncRoute(async (req, res) => {
    const user = req.chirpyUser;
    const handle = String(req.body.handle || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();

    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      return res.redirect("/app?tab=settings&handleError=invalid");
    }
    if (handle === user.handle) return res.redirect("/app?tab=settings");

    const nextAllowed = handleChangeAvailableAt(user);
    if (nextAllowed && nextAllowed.getTime() > Date.now()) {
      return res.redirect("/app?tab=settings&handleError=cooldown");
    }
    if (await isHandleTaken(handle, user._id)) {
      return res.redirect("/app?tab=settings&handleError=taken");
    }

    user.handle = handle;
    user.handleChangedAt = new Date();
    try {
      await user.save();
    } catch (error) {
      if (!isDuplicateHandleError(error)) throw error;
      return res.redirect("/app?tab=settings&handleError=taken");
    }

    return res.redirect("/app?tab=settings&saved=1");
  })
);

app.post(
  "/settings/verification",
  requireUser,
  asyncRoute(async (req, res) => {
    const user = req.chirpyUser;
    const reason = String(req.body.reason || "").trim().slice(0, 500);
    const settings = await getMaintenanceSettings();

    if (settings.verificationEnabled === false) {
      return res.redirect("/app?tab=settings&verification=disabled");
    }

    if (user.verificationStatus === "verified") {
      return res.redirect("/app?tab=settings&verification=alreadyVerified");
    }
    if (user.verificationStatus === "pending") {
      return res.redirect("/app?tab=settings&verification=pending");
    }
    const lastAppliedAt = user.verificationLastAppliedAt || user.verificationAppliedAt;
    if (!verificationApplicationAvailable(lastAppliedAt)) {
      return res.redirect("/app?tab=settings&verification=cooldown");
    }
    if (reason.length < 20) {
      return sendAppError(
        req,
        res,
        400,
        "Please provide at least 20 characters explaining why your account should be verified."
      );
    }

    const appliedAt = new Date();
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: user._id,
        terminated: false,
        verificationStatus: { $in: ["none", "rejected"] },
        verificationLastAppliedAt: user.verificationLastAppliedAt || null,
      },
      {
        $set: {
          verificationStatus: "pending",
          verificationReason: reason,
          verificationAppliedAt: appliedAt,
          verificationLastAppliedAt: appliedAt,
        },
      },
      { returnDocument: "after", runValidators: true }
    );
    if (!updatedUser) {
      return res.redirect("/app?tab=settings&verification=pending");
    }

    return res.redirect("/app?tab=settings&saved=1");
  })
);

app.post(
  "/settings/verification/outcome-seen",
  requireUser,
  asyncRoute(async (req, res) => {
    const noticeId = String(req.body.noticeId || "");
    if (!mongoose.isValidObjectId(noticeId)) {
      return res.status(400).json({ success: false, message: "That verification notice could not be found." });
    }
    const result = await VerificationOutcomeNotice.updateOne(
      { _id: noticeId, recipientId: req.chirpyUser._id, acknowledgedAt: null },
      { $set: { acknowledgedAt: new Date() } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: "That verification notice was already acknowledged or is unavailable." });
    }
    return res.json({ success: true });
  })
);

app.post(
  "/settings/verification/notice-seen",
  requireUser,
  asyncRoute(async (req, res) => {
    if (req.chirpyUser.verificationRemovalNotice) {
      req.chirpyUser.verificationRemovalNotice = false;
      await req.chirpyUser.save();
    }
    return res.json({ success: true });
  })
);

app.get(
  "/moderation",
  ...requireModerator,
  (req, res) => res.redirect(302, "/app?tab=moderation")
);

app.get(
  "/moderation/logs",
  ...requireModerator,
  (req, res) => res.redirect(302, "/app?tab=logs")
);

app.get(
  "/banland",
  ...requireModerator,
  (req, res) => {
    if (!canManageStaff(req.chirpyUser)) {
      return sendAppError(req, res, 403, "Banland is available to managers and owners.");
    }
    return res.redirect(302, "/app?tab=banland");
  }
);

app.post(
  "/moderation/verification-settings",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!canManageStaff(req.chirpyUser)) {
      return sendAppError(req, res, 403, "Only managers and owners can change verification availability.");
    }
    const enabledValue = String(req.body.enabled || "");
    if (!["true", "false"].includes(enabledValue)) {
      return sendAppError(req, res, 400, "Choose whether verification applications are on or off.");
    }
    const enabled = enabledValue === "true";
    await MaintenanceSettings.findByIdAndUpdate(
      "global",
      { $set: { verificationEnabled: enabled } },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );
    await writeAudit(
      req.chirpyUser._id,
      "verification_applications_toggled",
      "global",
      `enabled=${enabled}`
    );
    return res.redirect("/app?tab=moderation&notice=verificationSettingSaved");
  })
);

app.post(
  "/moderation/appeals/:id",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return sendAppError(req, res, 404, "That appeal could not be found.");
    }
    const decision = String(req.body.decision || "");
    if (!["accept", "deny"].includes(decision)) {
      return sendAppError(req, res, 400, "Choose whether to accept or deny the appeal.");
    }

    const accepted = decision === "accept";
    const now = new Date();
    const account = await User.findOneAndUpdate(
      {
        _id: req.params.id,
        terminated: true,
        appealUsed: true,
        appealStatus: "pending",
        ...(accepted
          ? reinstatementWindowFilter()
          : {}),
      },
      {
        $set: {
          appealStatus: accepted ? "accepted" : "denied",
          appealDecisionAt: now,
          appealDecisionBy: req.chirpyUser._id,
          ...(accepted ? { terminated: false } : {}),
        },
      },
      { returnDocument: "after", runValidators: true }
    );
    if (!account) {
      if (accepted) {
        const expiredAppeal = await User.exists({
          _id: req.params.id,
          terminated: true,
          appealUsed: true,
          appealStatus: "pending",
        });
        if (expiredAppeal) {
          return sendAppError(req, res, 410, "The appeal period has passed. This account can no longer be reinstated.");
        }
      }
      return sendAppError(req, res, 409, "That appeal has already been reviewed or is no longer available.");
    }

    await writeAudit(
      req.chirpyUser._id,
      accepted ? "termination_appeal_accepted" : "termination_appeal_denied",
      account.id,
      accepted ? "Appeal accepted; account reinstated." : "Appeal denied."
    );
    return res.redirect(`/app?tab=moderation&notice=${accepted ? "appealAccepted" : "appealDenied"}`);
  })
);

app.get(
  "/moderation/roles/lookup",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!canManageStaff(req.chirpyUser)) return sendAppError(req, res, 403, "Only managers and owners can look up role assignments.");
    const discordId = String(req.query.discordId || "").trim();
    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({ success: false, message: "Enter a valid Discord ID." });
    }

    const purgedIdentity = await AccountTombstone.exists({
      discordIdHash: discordIdentityHash(discordId),
    });
    if (purgedIdentity) {
      return res.status(410).json({
        success: false,
        message: "This Discord identity belongs to a purged account and cannot be reassigned.",
      });
    }

    const account = await User.findOne({ discordId })
      .select("_id discordId username displayName handle avatar terminated role partner")
      .lean();
    if (!account) {
      return res.json({
        success: true,
        found: false,
        message: "Awaiting first Discord sign-in. Discord does not reveal a profile from an ID alone.",
      });
    }

    return res.json({
      success: true,
      found: true,
      account: {
        displayName: account.displayName || account.username,
        username: account.username,
        handle: account.handle || "",
        avatarUrl: accountAvatarUrl(account),
        terminated: account.terminated,
        role: account.role,
        partner: Boolean(account.partner),
        isSelf: String(account._id) === String(req.chirpyUser._id),
      },
    });
  })
);

app.post(
  "/moderation/partner",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canManageStaff(actor)) {
      return sendAppError(req, res, 403, "Only managers and owners can manage partner badges.");
    }

    const discordId = String(req.body.discordId || "").trim();
    const enabledValue = String(req.body.enabled || "");
    if (!/^\d{17,20}$/.test(discordId)) {
      return sendAppError(req, res, 400, "Enter a valid Discord ID.");
    }
    if (!["true", "false"].includes(enabledValue)) {
      return sendAppError(req, res, 400, "Choose whether to grant or remove the partner badge.");
    }

    const target = await User.findOne({ discordId, terminated: false });
    if (!target) {
      return sendAppError(req, res, 404, "Partner badges can only be managed for an existing, active account.");
    }
    if (String(target._id) === String(actor._id)) {
      return sendAppError(req, res, 403, "You cannot change your own partner badge.");
    }

    const partner = enabledValue === "true";
    if (Boolean(target.partner) === partner) {
      return res.redirect("/app?tab=moderation&notice=partnerUnchanged");
    }
    target.partner = partner;
    await target.save();
    await writeAudit(
      actor._id,
      partner ? "partner_badge_granted" : "partner_badge_removed",
      target.id,
      `Discord ID ${target.discordId}`
    );

    return res.redirect("/app?tab=moderation&notice=partnerUpdated");
  })
);

app.post(
  "/moderation/maintenance",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canManageStaff(actor)) return sendAppError(req, res, 403, "Only managers and owners can change maintenance settings.");

    const enabledValue = String(req.body.enabled || "");
    const progressValue = String(req.body.progress ?? "");
    const progress = Number(progressValue);
    if (
      !["true", "false"].includes(enabledValue) ||
      !/^\d{1,3}$/.test(progressValue) ||
      !Number.isInteger(progress) ||
      progress < 0 ||
      progress > 100
    ) {
      return sendAppError(req, res, 400, "Choose a maintenance state and progress from 0 to 100.");
    }

    const enabled = enabledValue === "true";
    await MaintenanceSettings.findByIdAndUpdate(
      "global",
      { $set: { enabled, progress } },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );
    await writeAudit(
      actor._id,
      "maintenance_settings_changed",
      "global",
      `enabled=${enabled}; progress=${progress}`
    );

    return res.redirect("/app?tab=moderation");
  })
);

app.post(
  "/moderation/verification/:id",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canModerate(actor)) return sendAppError(req, res, 403, "You do not have permission to review verification applications.");
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That application could not be found.");

    const decision = req.body.decision;
    if (!["approve", "reject"].includes(decision)) return sendAppError(req, res, 400, "Choose approve or reject.");

    const applicant = await User.findOneAndUpdate(
      {
        _id: req.params.id,
        verificationStatus: "pending",
        terminated: false,
      },
      {
        $set: { verificationStatus: decision === "approve" ? "verified" : "rejected" },
      },
      { returnDocument: "after", runValidators: true }
    );
    if (!applicant) return sendAppError(req, res, 404, "That application could not be found or was already reviewed.");

    await VerificationOutcomeNotice.create({
      recipientId: applicant._id,
      outcome: decision === "approve" ? "approved" : "denied",
    });

    await writeAudit(
      actor._id,
      `verification_${decision}`,
      applicant.id,
      applicant.handle || ""
    );

    return res.redirect(`/app?tab=moderation&notice=verification${decision === "approve" ? "Approved" : "Denied"}`);
  })
);

app.post(
  "/moderation/users/:id/verification/remove",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canManageStaff(actor)) return sendAppError(req, res, 403, "Only managers and owners can remove verification.");
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That account could not be found.");

    const target = await User.findOne({
      _id: req.params.id,
      terminated: false,
      verificationStatus: "verified",
    });
    if (!target) return sendAppError(req, res, 404, "That account could not be found.");
    if (["moderator", "manager", "owner"].includes(target.role)) {
      return sendAppError(req, res, 403, "Verification cannot be removed from staff accounts.");
    }

    target.verificationStatus = "none";
    target.verificationReason = "";
    target.verificationAppliedAt = null;
    target.verificationRemovalNotice = true;
    await target.save();

    await writeAudit(actor._id, "verification_removed", target.id, "verified status removed by staff");
    return res.redirect("/app?tab=moderation");
  })
);

app.post(
  "/moderation/users/:id/role",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canManageStaff(actor)) return sendAppError(req, res, 403, "Only managers and owners can assign roles.");
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That account could not be found.");

    const target = await User.findById(req.params.id);
    if (!target || target.terminated) return sendAppError(req, res, 404, "That account could not be found.");

    const newRole = String(req.body.role || "");
    const validRoles = ["user", "moderator", "manager", "owner"];
    if (!validRoles.includes(newRole)) return sendAppError(req, res, 400, "Choose a valid staff role.");
    if (!canAssignRole(actor, target, newRole)) {
      return sendAppError(req, res, 403, "You do not have permission to assign that role.");
    }

    target.role = newRole;
    await target.save();
    await writeAudit(actor._id, "role_changed", target.id, newRole);

    return res.redirect("/moderation");
  })
);

app.post(
  "/moderation/roles",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canManageStaff(actor)) return sendAppError(req, res, 403, "Only managers and owners can assign roles.");

    const discordId = String(req.body.discordId || "").trim();
    const role = String(req.body.role || "");
    if (!/^\d{17,20}$/.test(discordId)) {
      return sendAppError(req, res, 400, "Enter a valid Discord user ID.");
    }
    if (!["user", "moderator", "manager", "owner"].includes(role)) {
      return sendAppError(req, res, 400, "Choose a valid role.");
    }
    if (await AccountTombstone.exists({ discordIdHash: discordIdentityHash(discordId) })) {
      return sendAppError(req, res, 410, "This Discord identity belongs to a purged account and cannot be reassigned.");
    }
    if (actor.role === "manager" && !["user", "moderator"].includes(role)) {
      return sendAppError(req, res, 403, "You do not have permission to assign that role.");
    }
    if (discordId === OWNER_DISCORD_ID && role !== "owner") {
      return sendAppError(req, res, 403, "The configured default owner cannot be demoted.");
    }

    const target = await User.findOne({ discordId });
    if (target) {
      if (target.terminated) return sendAppError(req, res, 404, "That account is terminated.");
      if (!canAssignRole(actor, target, role)) return sendAppError(req, res, 403, "You do not have permission to assign that role.");

      target.role = role;
      await target.save();
      await PendingRoleAssignment.deleteOne({ discordId });
      await writeAudit(actor._id, "role_changed", target.id, role);
    } else {
      const pending = await PendingRoleAssignment.findOne({ discordId });
      if (
        actor.role === "manager" &&
        pending &&
        pending.role !== "moderator"
      ) {
        return sendAppError(req, res, 403, "You do not have permission to remove that role.");
      }
      if (role === "user") {
        if (!pending) return sendAppError(req, res, 404, "That pending role assignment could not be found.");
        await pending.deleteOne();
      } else {
        await PendingRoleAssignment.findOneAndUpdate(
          { discordId },
          { $set: { role } },
          { upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );
      }
      await writeAudit(actor._id, "role_assigned_pending", discordId, role);
    }

    return res.redirect("/app?tab=moderation");
  })
);

app.post(
  "/moderation/posts/:id/delete",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That post could not be found.");

    const post = await Post.findById(req.params.id);
    if (!post || post.deleted) return sendAppError(req, res, 404, "That post could not be found.");

    post.deleted = true;
    await post.save();
    await Notification.deleteMany({ postId: post._id });
    await writeAudit(req.chirpyUser._id, "post_deleted", post.id);

    return res.redirect(req.get("Referrer") || "/app");
  })
);

app.post(
  "/moderation/users/:id/mute",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That account could not be found.");

    const target = await User.findById(req.params.id);
    if (!target || target.terminated) return sendAppError(req, res, 404, "That account could not be found.");
    if (!canModerateTarget(req.chirpyUser, target)) {
      return redirectWithNotice(req, res, "action", "/app?tab=moderation");
    }
    const until = muteDuration(String(req.body.duration || ""));
    if (until === undefined) {
      return redirectWithNotice(req, res, "action", "/app?tab=moderation");
    }
    const reason = String(req.body.reason || "").trim().slice(0, 300);
    target.muted = true;
    target.mutedUntil = until;
    target.mutedReason = reason;
    target.mutedBy = req.chirpyUser._id;
    await target.save();
    await writeAudit(
      req.chirpyUser._id,
      "user_muted",
      target.id,
      `until=${until ? until.toISOString() : "permanent"}; reason=${reason}`
    );

    return redirectWithNotice(req, res, "muteSaved", "/app?tab=moderation");
  })
);

app.post(
  "/moderation/users/:id/unmute",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That account could not be found.");

    const target = await User.findById(req.params.id);
    if (!target) return sendAppError(req, res, 404, "That account could not be found.");
    if (!canModerateTarget(req.chirpyUser, target)) {
      return redirectWithNotice(req, res, "action", "/app?tab=moderation");
    }

    target.muted = false;
    target.mutedUntil = null;
    target.mutedReason = "";
    target.mutedBy = null;
    await target.save();
    await writeAudit(req.chirpyUser._id, "user_unmuted", target.id);

    return redirectWithNotice(req, res, "unmuted", "/app?tab=moderation");
  })
);

app.post(
  "/moderation/users/:id/terminate",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That account could not be found.");

    const target = await User.findById(req.params.id);
    if (!target || target.terminated) return sendAppError(req, res, 404, "That account could not be found.");
    if (!canTerminateUser(req.chirpyUser, target)) {
      return sendAppError(req, res, 403, "You do not have permission to terminate this account.");
    }

    target.terminated = true;
    target.terminationReason =
      String(req.body.reason || "").trim().slice(0, 500) ||
      "Terminated by staff.";
    target.terminatedAt = new Date();
    target.terminatedBy = req.chirpyUser._id;
    await target.save();
    await Follow.deleteMany({
      $or: [{ followerId: target._id }, { followingId: target._id }],
    });

    await writeAudit(
      req.chirpyUser._id,
      "account_terminated",
      target.id,
      target.terminationReason
    );

    return res.redirect(req.get("Referrer") || "/moderation");
  })
);

app.post(
  "/moderation/users/:id/unban",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!canManageStaff(req.chirpyUser)) return sendAppError(req, res, 403, "Only managers and owners can reinstate accounts.");
    if (!mongoose.isValidObjectId(req.params.id)) return sendAppError(req, res, 404, "That account could not be found.");

    const target = await User.findOneAndUpdate(
      {
        _id: req.params.id,
        terminated: true,
        ...reinstatementWindowFilter(),
      },
      { $set: { terminated: false } },
      { returnDocument: "after" }
    );
    if (!target) {
      const [purged, expired] = await Promise.all([
        AccountTombstone.exists({ accountId: req.params.id }),
        User.exists({ _id: req.params.id, terminated: true }),
      ]);
      if (purged) {
        return sendAppError(req, res, 410, "This account passed the 30-day reinstatement period and its data has been purged.");
      }
      if (expired) {
        return sendAppError(
          req,
          res,
          410,
          "The 30-day reinstatement period has passed. This account cannot be restored; its content will be purged while a minimal reservation record is retained."
        );
      }
      return sendAppError(req, res, 404, "That account could not be found.");
    }
    await writeAudit(req.chirpyUser._id, "account_reinstated", target.id);

    return res.redirect("/app?tab=banland");
  })
);

app.post("/logout", asyncRoute(async (req, res) => {
  await clearSession(req, res);
  return res.redirect("/");
}));

app.use((req, res) => {
  return sendAppError(req, res, 404, "We couldn't find the page you were looking for.");
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);

  const status =
    Number.isInteger(error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
  if (req.method === "POST" && /^\/posts\/[^/]+\/poll$/.test(req.path)) {
    return res.status(status).json({
      success: false,
      message:
        status === 500
          ? "The poll vote could not be saved because of a server error. Please try again."
          : "The poll request was invalid. Please choose an available option and try again.",
    });
  }

  if (req.method === "GET" && /^\/posts\/[^/]+\/image$/.test(req.path)) {
    return res.status(status).end();
  }

  if (status === 413) {
    return sendAppError(req, res, status, "The request is too large. Images must be 5 MB or smaller.");
  }

  return sendAppError(
    req,
    res,
    status,
    status === 500
      ? "Something went wrong. Please reload Chirpy and try again."
      : "The request could not be completed. Please check the details and try again."
  );
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB.");
  await Follow.init();
  await migrateNotificationIndexes();
  await AccountTombstone.init();
  await purgeExpiredTerminations();
  const removedReactions = await Post.collection.updateMany(
    { reactions: { $exists: true } },
    { $unset: { reactions: "" } }
  );
  if (removedReactions.modifiedCount) {
    console.log(`Removed legacy reactions from ${removedReactions.modifiedCount} posts.`);
  }
  await MaintenanceSettings.findByIdAndUpdate(
    "global",
    { $setOnInsert: { enabled: true, progress: 2 } },
    {
      returnDocument: "after",
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  const accountPurgeTimer = setInterval(() => {
    purgeExpiredTerminations().catch((error) => {
      console.error("Could not purge expired terminated accounts:", error);
    });
  }, 60 * 60 * 1000);
  accountPurgeTimer.unref();

  app.listen(PORT, () => {
    console.log(`Chirpy is running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Could not start Chirpy:", error);
  process.exitCode = 1;
});