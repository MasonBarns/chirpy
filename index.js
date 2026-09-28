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
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const CONFIGURED_DISCORD_REDIRECT_URI = String(
  process.env.DISCORD_REDIRECT_URI || ""
).trim();

function getDiscordRedirectUri(req) {
  if (CONFIGURED_DISCORD_REDIRECT_URI) return CONFIGURED_DISCORD_REDIRECT_URI;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();

  if (!host) return `http://localhost:${PORT}/auth/discord/callback`;
  return `${protocol}://${host}/auth/discord/callback`;
}

const OWNER_DISCORD_ID = "1147930457439223920";
const HANDLE_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const LOGO_PATH = path.resolve(__dirname, "public", "images", "chripy.png");
const POST_REACTIONS = ["❤️", "😂", "😮", "😢", "👍", "🎉"];

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
    return res.status(404).send(
      `Chirpy logo not found. Expected file: ${LOGO_PATH}`
    );
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
    muted: { type: Boolean, default: false },
    terminated: { type: Boolean, default: false },
    terminationReason: { type: String, default: "", maxlength: 500 },
    terminatedAt: { type: Date, default: null },
    terminatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    verificationStatus: {
      type: String,
      enum: ["none", "pending", "verified", "rejected"],
      default: "none",
    },
    verificationReason: { type: String, default: "", maxlength: 500 },
    verificationAppliedAt: { type: Date, default: null },
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

const reactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    emoji: { type: String, enum: POST_REACTIONS, required: true },
  },
  { _id: false }
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
    imageUrl: { type: String, default: "" },
    imageData: { type: Buffer, default: null },
    imageMime: {
      type: String,
      enum: ["image/png", "image/jpeg", "image/gif", "image/webp", null],
      default: null,
    },
    likes: [{ type: mongoose.Schema.Types.ObjectId }],
    reposts: [{ type: mongoose.Schema.Types.ObjectId }],
    bookmarks: [{ type: mongoose.Schema.Types.ObjectId }],
    reactions: [reactionSchema],
    poll: { type: pollSchema, default: null },
    comments: [commentSchema],
    deleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

const messageSchema = new mongoose.Schema(
  {
    senderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    text: { type: String, required: true, maxlength: 1000 },
  },
  { timestamps: true }
);

const auditSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    action: { type: String, required: true },
    targetId: { type: String, default: "" },
    details: { type: String, default: "" },
  },
  { timestamps: true }
);

const maintenanceSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  enabled: { type: Boolean, default: true },
  progress: { type: Number, min: 0, max: 100, default: 2 },
});

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
const AuditLog = mongoose.model("AuditLog", auditSchema);
const MaintenanceSettings = mongoose.model(
  "MaintenanceSettings",
  maintenanceSettingsSchema
);
const PendingRoleAssignment = mongoose.model(
  "PendingRoleAssignment",
  pendingRoleAssignmentSchema
);

// OAuth state and sessions are short-lived; account/content data is MongoDB-backed.
const sessions = new Map();

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
    if (key === name) return decodeURIComponent(value.join("="));
  }

  return null;
}

function setSessionCookie(res, id) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `chirpy_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`
  );
}

function getSession(req) {
  const id = readCookie(req, "chirpy_session");
  return id ? sessions.get(id) || null : null;
}

function getOrCreateSession(req, res) {
  const existing = getSession(req);
  if (existing) return existing;

  const id = createId();
  const session = { adminVerified: false, discordState: null, userId: null };
  sessions.set(id, session);
  setSessionCookie(res, id);
  return session;
}

function rotateSession(req, res, updates) {
  const oldId = readCookie(req, "chirpy_session");
  const previous = oldId ? sessions.get(oldId) : null;
  if (oldId) sessions.delete(oldId);

  const id = createId();
  const session = { ...previous, ...updates };
  sessions.set(id, session);
  setSessionCookie(res, id);
  return session;
}

function clearSession(req, res) {
  const id = readCookie(req, "chirpy_session");
  if (id) sessions.delete(id);

  res.setHeader(
    "Set-Cookie",
    "chirpy_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  );
}

function safeCompare(first, second) {
  const a = Buffer.from(String(first || ""), "utf8");
  const b = Buffer.from(String(second || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function renderPage(res, page, locals = {}) {
  return res.render("index", {
    page,
    error: "",
    handleError: "",
    handle: "",
    displayName: "",
    saved: false,
    handleChangeAvailableAt: null,
    handleChangeAllowed: true,
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
    maintenanceSettings: { enabled: true, progress: 2 },
    avatarUrl: accountAvatarUrl,
    ...locals,
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

  let mime = null;
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    mime = "image/png";
  } else if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    mime = "image/jpeg";
  } else if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
  ) {
    mime = "image/gif";
  } else if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    mime = "image/webp";
  }

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

async function getMaintenanceSettings() {
  return (
    (await MaintenanceSettings.findById("global").lean()) || {
      enabled: true,
      progress: 2,
    }
  );
}

const requireUser = asyncRoute(async (req, res, next) => {
  const session = getSession(req);
  if (!session?.userId) return res.redirect("/login");

  const user = await User.findById(session.userId);
  if (!user || user.terminated) {
    clearSession(req, res);
    return res.redirect("/");
  }
  const maintenanceSettings = await getMaintenanceSettings();
  if (maintenanceSettings.enabled && !canModerate(user)) {
    return res.redirect("/");
  }
  if (!user.handle) return res.redirect("/onboarding");

  req.chirpyUser = user;
  return next();
});

const requireModerator = [
  requireUser,
  (req, res, next) => {
    if (!canModerate(req.chirpyUser)) return res.sendStatus(403);
    return next();
  },
];

function isHandleTaken(handle, exceptUserId) {
  const normalizedHandle = String(handle || "").trim().toLowerCase();
  const escapedHandle = normalizedHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return User.exists({
    handle: { $regex: `^${escapedHandle}$`, $options: "i" },
    _id: { $ne: exceptUserId },
  });
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
    const session = getSession(req);
    if (session?.userId) {
      const user = await User.findById(session.userId);
      if (user && !user.terminated) {
        if (!maintenanceSettings.enabled || canModerate(user)) {
          return res.redirect("/app");
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

app.post("/admin/verify", (req, res) => {
  if (!safeCompare(req.body.password, ADMIN_PASSWORD)) {
    return res.status(401).json({
      success: false,
      message: "That password is incorrect.",
    });
  }

  const session = getOrCreateSession(req, res);
  session.adminVerified = true;
  return res.json({ success: true, redirect: "/login" });
});

app.get(
  "/login",
  asyncRoute(async (req, res) => {
    const maintenanceSettings = await getMaintenanceSettings();
    const session = getSession(req);
    if (maintenanceSettings.enabled && !session?.adminVerified) {
      return res.redirect("/");
    }

    if (session?.userId) return res.redirect("/app");

    return renderPage(res, "login", {
      error:
        req.query.error === "discord"
          ? "Discord sign-in was cancelled or could not be completed. Please try again."
          : "",
    });
  })
);

app.get(
  "/auth/discord",
  asyncRoute(async (req, res) => {
    const maintenanceSettings = await getMaintenanceSettings();
    const existingSession = getSession(req);
    if (maintenanceSettings.enabled && !existingSession?.adminVerified) {
      return res.redirect("/");
    }

    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      return res.status(503).send(
        "Discord OAuth is not configured. Add the Discord credentials to .env."
      );
    }

    const session = getOrCreateSession(req, res);
    const state = crypto.randomBytes(24).toString("hex");
    session.discordState = state;

    const redirectUri = getDiscordRedirectUri(req);
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", DISCORD_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);

    return res.redirect(url.toString());
  })
);

app.get(
  "/auth/discord/callback",
  asyncRoute(async (req, res) => {
    const session = getSession(req);
    const { code, state, error } = req.query;

    if (error) return res.redirect("/login?error=discord");
    if (!session || !code || state !== session.discordState) {
      return res.status(400).send("Invalid Discord sign-in request. Try again.");
    }

    session.discordState = null;

    const redirectUri = getDiscordRedirectUri(req);
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      console.error("Discord token exchange failed:", await tokenResponse.text());
      return res.status(401).send("Discord sign-in failed. Please try again.");
    }

    const token = await tokenResponse.json();
    const profileResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    if (!profileResponse.ok) {
      return res.status(401).send("Unable to read your Discord profile.");
    }

    const profile = await profileResponse.json();
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
      return res.status(403).send(
        "This Chirpy account has been terminated. Contact the site owner if you believe this is an error."
      );
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

    rotateSession(req, res, {
      adminVerified: true,
      userId: user.id,
      discordState: null,
    });

    return res.redirect(user.handle ? "/app" : "/onboarding");
  })
);

app.get(
  "/onboarding",
  asyncRoute(async (req, res) => {
    const session = getSession(req);
    const maintenanceSettings = await getMaintenanceSettings();
    if (maintenanceSettings.enabled && !session?.adminVerified) {
      return res.redirect("/");
    }

    const user = session?.userId ? await User.findById(session.userId) : null;
    if (!user || user.terminated) return res.redirect("/login");
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
    const session = getSession(req);
    const maintenanceSettings = await getMaintenanceSettings();
    if (
      !session?.userId ||
      (maintenanceSettings.enabled && !session.adminVerified)
    ) {
      return res.redirect("/login");
    }

    const user = await User.findById(session.userId);
    if (!user || user.terminated) return res.redirect("/login");
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

    return res.redirect("/app");
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
      "bookmarks",
      "profile",
      "settings",
      "banland",
      "moderation",
    ];
    const requestedTab = String(req.query.tab || "home");
    const activeTab = allowedTabs.includes(requestedTab)
      ? requestedTab
      : "home";
    const profileView =
      req.query.profileView === "reposts" ? "reposts" : "posts";
    const query = String(req.query.q || "").trim().slice(0, 80);
    const user = req.chirpyUser;
    const maintenanceSettings = await getMaintenanceSettings();

    if (activeTab === "moderation" && !canModerate(user)) {
      return res.redirect("/app");
    }
    if (activeTab === "banland" && !canManageStaff(user)) {
      return res.redirect("/app?tab=moderation");
    }
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

    const posts = activeTab === "messages" || activeTab === "settings" || activeTab === "moderation" || activeTab === "banland"
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
            "_id discordId username handle displayName avatar role verificationStatus"
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

    const staffUsers =
      activeTab === "moderation" && canModerate(user)
        ? await User.find({ _id: { $ne: user._id } })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean()
        : [];
    const terminatedUsers =
      activeTab === "banland" && canManageStaff(user)
        ? await User.find({ terminated: true })
            .sort({ terminatedAt: -1, updatedAt: -1 })
            .limit(200)
            .lean()
        : [];
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
      query,
      saved: req.query.saved === "1",
      handleError: handleErrors[String(req.query.handleError || "")] || "",
      handleChangeAvailableAt: nextHandleChange,
      handleChangeAllowed,
      posts,
      userMap,
      messages,
      messageUserMap,
      staffUsers,
      terminatedUsers,
      terminationActorMap,
      applications,
      verifiedUsers,
      pendingRoleAssignments,
      roleAssignmentUserMap,
      maintenanceSettings,
    });
  })
);

app.post(
  "/posts",
  requireUser,
  asyncRoute(async (req, res) => {
    if (req.chirpyUser.muted) {
      return res.status(403).send("Your account is muted. Contact a moderator.");
    }

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

    await Post.create({
      authorId: req.chirpyUser._id,
      text,
      imageData: image ? image.bytes : null,
      imageMime: image ? image.mime : null,
      poll,
    });

    return res.json({ success: true, redirect: "/app" });
  })
);

app.get(
  "/posts/:id/image",
  requireUser,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
    const post = await Post.findOne({
      _id: req.params.id,
      deleted: false,
    }).select("imageData imageMime");
    if (
      !post ||
      !post.imageData ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        post.imageMime
      )
    ) {
      return res.sendStatus(404);
    }

    res.set({
      "Cache-Control": "private, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    res.type(post.imageMime);
    return res.send(post.imageData);
  })
);

app.post(
  "/posts/:id/reactions",
  requireUser,
  asyncRoute(async (req, res) => {
    if (req.chirpyUser.muted) {
      return res.status(403).json({ success: false, message: "Your account is muted." });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    const emoji = String(req.body.emoji || "");
    if (!POST_REACTIONS.includes(emoji)) {
      return res.status(400).json({ success: false, message: "Choose a supported reaction." });
    }

    const postId = new mongoose.Types.ObjectId(req.params.id);
    const userId = new mongoose.Types.ObjectId(String(req.chirpyUser._id));
    const actorReactions = {
      $filter: {
        input: { $ifNull: ["$reactions", []] },
        as: "reaction",
        cond: { $eq: ["$$reaction.userId", userId] },
      },
    };
    const sameReaction = {
      $in: [
        emoji,
        {
          $map: {
            input: actorReactions,
            as: "reaction",
            in: "$$reaction.emoji",
          },
        },
      ],
    };
    const update = await Post.updateOne(
      { _id: postId, deleted: false },
      [
        {
          $set: {
            reactions: {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ["$reactions", []] },
                    as: "reaction",
                    cond: { $ne: ["$$reaction.userId", userId] },
                  },
                },
                { $cond: [sameReaction, [], [{ $literal: { userId, emoji } }]] },
              ],
            },
          },
        },
      ],
      { updatePipeline: true }
    );
    if (!update.matchedCount) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }

    const post = await Post.findById(postId).select("reactions").lean();
    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found." });
    }
    const counts = Object.fromEntries(POST_REACTIONS.map((item) => [item, 0]));
    let activeEmoji = null;
    for (const reaction of post.reactions || []) {
      if (counts[reaction.emoji] !== undefined) counts[reaction.emoji] += 1;
      if (String(reaction.userId) === String(userId)) activeEmoji = reaction.emoji;
    }
    return res.json({ success: true, counts, activeEmoji });
  })
);

app.post(
  "/posts/:id/poll",
  requireUser,
  asyncRoute(async (req, res) => {
    if (req.chirpyUser.muted) {
      return res.status(403).json({ success: false, message: "Your account is muted." });
    }
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
  asyncRoute(async (req, res) => {
    if (req.chirpyUser.muted) {
      return res.status(403).json({ success: false, message: "Your account is muted." });
    }

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
    if (req.chirpyUser.muted) {
      return res.status(403).json({ success: false, message: "Your account is muted." });
    }
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
    await post.save();

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
    if (req.chirpyUser.muted) return res.status(403).send("Your account is muted.");

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

    await Message.create({
      senderId: req.chirpyUser._id,
      recipientId: recipient._id,
      text,
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

    if (user.verificationStatus === "verified") {
      return res.redirect("/app?tab=settings");
    }
    if (user.verificationStatus === "pending") {
      return res.redirect("/app?tab=settings&saved=1");
    }
    if (reason.length < 20) {
      return res.status(400).send(
        "Please provide at least 20 characters explaining why your account should be verified."
      );
    }

    user.verificationStatus = "pending";
    user.verificationReason = reason;
    user.verificationAppliedAt = new Date();
    await user.save();

    return res.redirect("/app?tab=settings&saved=1");
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
  (req, res) => res.redirect("/app?tab=moderation")
);

app.get(
  "/moderation/roles/lookup",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!canManageStaff(req.chirpyUser)) return res.sendStatus(403);
    const discordId = String(req.query.discordId || "").trim();
    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).json({ success: false, message: "Enter a valid Discord ID." });
    }

    const account = await User.findOne({ discordId })
      .select("discordId username displayName handle avatar terminated")
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
      },
    });
  })
);

app.post(
  "/moderation/maintenance",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canManageStaff(actor)) return res.sendStatus(403);

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
      return res.status(400).send("Choose a maintenance state and progress from 0 to 100.");
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
    if (!canModerate(actor)) return res.sendStatus(403);
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const decision = req.body.decision;
    if (!["approve", "reject"].includes(decision)) return res.sendStatus(400);

    const applicant = await User.findOne({
      _id: req.params.id,
      verificationStatus: "pending",
      terminated: false,
    });
    if (!applicant) return res.sendStatus(404);

    applicant.verificationStatus = decision === "approve" ? "verified" : "rejected";
    await applicant.save();

    await writeAudit(
      actor._id,
      `verification_${decision}`,
      applicant.id,
      applicant.handle || ""
    );

    return res.redirect("/moderation");
  })
);

app.post(
  "/moderation/users/:id/verification/remove",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    const actor = req.chirpyUser;
    if (!canManageStaff(actor)) return res.sendStatus(403);
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const target = await User.findOne({
      _id: req.params.id,
      terminated: false,
      verificationStatus: "verified",
    });
    if (!target) return res.sendStatus(404);
    if (["moderator", "manager", "owner"].includes(target.role)) {
      return res.status(403).send("Verification cannot be removed from staff accounts.");
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
    if (!canManageStaff(actor)) return res.sendStatus(403);
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const target = await User.findById(req.params.id);
    if (!target || target.terminated) return res.sendStatus(404);

    const newRole = String(req.body.role || "");
    const validRoles = ["user", "moderator", "manager", "owner"];
    if (!validRoles.includes(newRole)) return res.sendStatus(400);
    if (!canAssignRole(actor, target, newRole)) {
      return res.sendStatus(403);
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
    if (!canManageStaff(actor)) return res.sendStatus(403);

    const discordId = String(req.body.discordId || "").trim();
    const role = String(req.body.role || "");
    if (!/^\d{17,20}$/.test(discordId)) {
      return res.status(400).send("Enter a valid Discord user ID.");
    }
    if (!["user", "moderator", "manager", "owner"].includes(role)) {
      return res.status(400).send("Choose a valid role.");
    }
    if (actor.role === "manager" && !["user", "moderator"].includes(role)) {
      return res.sendStatus(403);
    }
    if (discordId === OWNER_DISCORD_ID && role !== "owner") {
      return res.status(403).send("The configured default owner cannot be demoted.");
    }

    const target = await User.findOne({ discordId });
    if (target) {
      if (target.terminated) return res.status(404).send("That account is terminated.");
      if (!canAssignRole(actor, target, role)) return res.sendStatus(403);

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
        return res.sendStatus(403);
      }
      if (role === "user") {
        if (!pending) return res.sendStatus(404);
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
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const post = await Post.findById(req.params.id);
    if (!post || post.deleted) return res.sendStatus(404);

    post.deleted = true;
    await post.save();
    await writeAudit(req.chirpyUser._id, "post_deleted", post.id);

    return res.redirect(req.get("Referrer") || "/app");
  })
);

app.post(
  "/moderation/users/:id/mute",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const target = await User.findById(req.params.id);
    if (!target || target.terminated) return res.sendStatus(404);
    if (
      (target.role === "owner" && req.chirpyUser.role !== "owner") ||
      target.discordId === OWNER_DISCORD_ID ||
      String(target._id) === String(req.chirpyUser._id)
    ) {
      return res.status(403).send("You cannot mute yourself or an owner.");
    }

    target.muted = true;
    await target.save();
    await writeAudit(req.chirpyUser._id, "user_muted", target.id);

    return res.redirect(req.get("Referrer") || "/moderation");
  })
);

app.post(
  "/moderation/users/:id/unmute",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const target = await User.findById(req.params.id);
    if (!target) return res.sendStatus(404);
    if (
      (target.role === "owner" && req.chirpyUser.role !== "owner") ||
      target.discordId === OWNER_DISCORD_ID ||
      String(target._id) === String(req.chirpyUser._id)
    ) {
      return res.status(403).send("You cannot unmute yourself or an owner.");
    }

    target.muted = false;
    await target.save();
    await writeAudit(req.chirpyUser._id, "user_unmuted", target.id);

    return res.redirect(req.get("Referrer") || "/moderation");
  })
);

app.post(
  "/moderation/users/:id/terminate",
  ...requireModerator,
  asyncRoute(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const target = await User.findById(req.params.id);
    if (!target || target.terminated) return res.sendStatus(404);
    if (!canTerminateUser(req.chirpyUser, target)) {
      return res.status(403).send("You do not have permission to terminate this account.");
    }

    target.terminated = true;
    target.terminationReason =
      String(req.body.reason || "").trim().slice(0, 500) ||
      "Terminated by staff.";
    target.terminatedAt = new Date();
    target.terminatedBy = req.chirpyUser._id;
    await target.save();

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
    if (!canManageStaff(req.chirpyUser)) return res.sendStatus(403);
    if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);

    const target = await User.findOne({
      _id: req.params.id,
      terminated: true,
    });
    if (!target) return res.sendStatus(404);

    target.terminated = false;
    await target.save();
    await writeAudit(req.chirpyUser._id, "account_reinstated", target.id);

    return res.redirect("/app?tab=banland");
  })
);

app.post("/logout", (req, res) => {
  clearSession(req, res);
  return res.redirect("/");
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);

  if (req.method === "POST" && /^\/posts\/[^/]+\/poll$/.test(req.path)) {
    const status =
      Number.isInteger(error.status) && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    return res.status(status).json({
      success: false,
      message:
        status === 500
          ? "The poll vote could not be saved because of a server error. Please try again."
          : "The poll request was invalid. Please choose an available option and try again.",
    });
  }

  if (error.status === 413) {
    return res.status(413).send("The request is too large. Images must be 5 MB or smaller.");
  }

  return res.status(500).send(
    "Something went wrong. Check the server terminal for details."
  );
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB.");
  await MaintenanceSettings.findByIdAndUpdate(
    "global",
    { $setOnInsert: { enabled: true, progress: 2 } },
    {
      returnDocument: "after",
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  app.listen(PORT, () => {
    console.log(`Chirpy is running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Could not start Chirpy:", error);
  process.exitCode = 1;
});
