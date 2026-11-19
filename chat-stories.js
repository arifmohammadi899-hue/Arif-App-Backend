const crypto = require("crypto");

module.exports = function registerChatStories(app, deps) {
  const { marketConfig, marketSession, marketUser, arifChatIsBlocked } = deps;

  let cleanupRunning = false;

  function auth(req, res) {
    const session = marketSession(req);
    if (!session) {
      res.status(401).json({
        success: false,
        message: "ابتدا وارد حساب شوید"
      });
      return null;
    }
    return session;
  }

  async function currentUser(session) {
    return marketUser(session.email);
  }

  async function privateConversation(ownerId, viewerId) {
    const { base, key } = marketConfig();
    const one = Math.min(Number(ownerId), Number(viewerId));
    const two = Math.max(Number(ownerId), Number(viewerId));

    const q = new URLSearchParams({
      select: "id,user_one_id,user_two_id,conversation_type",
      user_one_id: "eq." + one,
      user_two_id: "eq." + two,
      conversation_type: "eq.private",
      limit: "1"
    });

    const r = await fetch(base + "/rest/v1/chat_conversations?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!r.ok) throw new Error("story_conversation_lookup_failed");
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function canViewStories(ownerId, viewerId) {
    if (Number(ownerId) === Number(viewerId)) return true;

    const conversation = await privateConversation(ownerId, viewerId);
    if (!conversation) return false;

    if (await arifChatIsBlocked(conversation, viewerId)) return false;

    const { base, key } = marketConfig();
    const q = new URLSearchParams({
      select: "id",
      conversation_id: "eq." + conversation.id,
      message_type: "in.(text,image,video,audio)",
      limit: "1"
    });

    const r = await fetch(base + "/rest/v1/chat_messages?" + q, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });

    if (!r.ok) throw new Error("story_message_eligibility_failed");
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  }

  async function signedStoryUrl(path) {
    const { base, key } = marketConfig();
    const encoded = String(path).split("/")
      .map(encodeURIComponent).join("/");

    const r = await fetch(
      base + "/storage/v1/object/sign/chat-stories/" + encoded,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );

    if (!r.ok) return null;
    const data = await r.json();
    const signed = String(data.signedURL || data.signedUrl || "");
    if (!signed) return null;
    if (/^https?:\/\//i.test(signed)) return signed;

    return base + (signed.startsWith("/storage/v1/")
      ? signed
      : "/storage/v1" + (signed.startsWith("/") ? signed : "/" + signed));
  }

  async function deleteStoryObject(path) {
    if (!path) return true;
    const { base, key } = marketConfig();
    const encoded = String(path).split("/")
      .map(encodeURIComponent).join("/");

    const r = await fetch(
      base + "/storage/v1/object/chat-stories/" + encoded,
      {
        method: "DELETE",
        headers: { apikey: key, Authorization: "Bearer " + key }
      }
    );

    return r.ok || r.status === 404;
  }

  app.get("/api/chat/users/:id/profile", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = auth(req, res);
    if (!session) return;

    try {
      const targetId = Number(req.params.id);
      if (!Number.isSafeInteger(targetId) || targetId <= 0) {
        return res.status(400).json({
          success: false,
          message: "شناسه کاربر معتبر نیست"
        });
      }

      const me = await currentUser(session);
      if (!me) {
        return res.status(404).json({
          success: false,
          message: "حساب کاربری پیدا نشد"
        });
      }

      const myId = Number(me.id);
      if (myId === targetId) {
        return res.status(400).json({
          success: false,
          message: "این مسیر مخصوص پروفایل مخاطب است"
        });
      }

      const conversation = await privateConversation(myId, targetId);
      if (!conversation) {
        return res.status(403).json({
          success: false,
          message: "پروفایل فقط از طریق گفت‌وگوی خصوصی قابل مشاهده است"
        });
      }

      if (await arifChatIsBlocked(conversation, myId)) {
        return res.status(403).json({
          success: false,
          blocked: true,
          message: "این ارتباط در دسترس نیست"
        });
      }

      const { base, key } = marketConfig();
      const q = new URLSearchParams({
        select: "id,first_name,surname,username,profile_photo_path",
        id: "eq." + targetId,
        limit: "1"
      });

      const r = await fetch(base + "/rest/v1/app_users?" + q, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });

      if (!r.ok) throw new Error("contact_profile_lookup_failed");
      const rows = await r.json();
      const user = Array.isArray(rows) ? rows[0] : null;

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "کاربر پیدا نشد"
        });
      }

      const photo = user.profile_photo_path
        ? await (async () => {
            const encoded = String(user.profile_photo_path)
              .split("/").map(encodeURIComponent).join("/");
            const sr = await fetch(
              base + "/storage/v1/object/sign/marketplace-media/" + encoded,
              {
                method: "POST",
                headers: {
                  apikey: key,
                  Authorization: "Bearer " + key,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ expiresIn: 3600 })
              }
            );
            if (!sr.ok) return "";
            const sd = await sr.json();
            const signed = String(sd.signedURL || sd.signedUrl || "");
            if (!signed) return "";
            return /^https?:\/\//i.test(signed)
              ? signed
              : base + (signed.startsWith("/storage/v1/")
                  ? signed
                  : "/storage/v1" + (signed.startsWith("/") ? signed : "/" + signed));
          })()
        : "";

      return res.json({
        success: true,
        profile: {
          id: user.id,
          first_name: user.first_name || "",
          surname: user.surname || "",
          username: user.username || "",
          profile_photo_url: photo
        }
      });
    } catch (e) {
      console.error("ARIF_CONTACT_PROFILE_ERROR:", String(e.message || e).slice(0, 150));
      return res.status(503).json({
        success: false,
        message: "دریافت پروفایل مخاطب ناموفق بود"
      });
    }
  });

  app.post("/api/chat/stories", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = auth(req, res);
    if (!session) return;

    let uploadedPath = null;

    try {
      const me = await currentUser(session);
      if (!me) {
        return res.status(404).json({
          success: false,
          message: "حساب کاربری پیدا نشد"
        });
      }

      const dataUrl = String(req.body?.media_data || "");
      const match = dataUrl.match(
        /^data:(image\/(?:jpeg|png|webp)|video\/(?:mp4|quicktime|webm));base64,([A-Za-z0-9+/=]+)$/
      );

      if (!match) {
        return res.status(400).json({
          success: false,
          message: "فرمت عکس یا ویدئو معتبر نیست"
        });
      }

      const mime = match[1];
      const buffer = Buffer.from(match[2], "base64");

      if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
        return res.status(413).json({
          success: false,
          message: "حجم استوری نباید بیشتر از ۲۰ مگابایت باشد"
        });
      }

      const extensions = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/webm": "webm"
      };

      const mediaType = mime.startsWith("image/") ? "image" : "video";
      const ownerId = Number(me.id);
      const path = ownerId + "/" + crypto.randomUUID() + "." + extensions[mime];
      const { base, key } = marketConfig();
      const encoded = path.split("/").map(encodeURIComponent).join("/");

      const upload = await fetch(
        base + "/storage/v1/object/chat-stories/" + encoded,
        {
          method: "POST",
          headers: {
            apikey: key,
            Authorization: "Bearer " + key,
            "Content-Type": mime,
            "x-upsert": "false"
          },
          body: buffer
        }
      );

      if (!upload.ok) {
        const detail = (await upload.text()).slice(0, 180);
        console.error("ARIF_STORY_UPLOAD_ERROR:", upload.status, detail);
        return res.status(503).json({
          success: false,
          message: "آپلود استوری ناموفق بود"
        });
      }

      uploadedPath = path;
      const caption = String(req.body?.caption || "").trim().slice(0, 500);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const insert = await fetch(base + "/rest/v1/arif_chat_stories", {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          owner_id: ownerId,
          media_path: path,
          media_type: mediaType,
          caption,
          expires_at: expiresAt
        })
      });

      if (!insert.ok) {
        await deleteStoryObject(path);
        uploadedPath = null;
        throw new Error("story_database_insert_failed_" + insert.status);
      }

      const rows = await insert.json();
      const story = Array.isArray(rows) ? rows[0] : null;

      if (!story || !story.id) {
        const cleanupQuery = new URLSearchParams({
          owner_id: "eq." + ownerId,
          media_path: "eq." + path
        });
        await fetch(base + "/rest/v1/arif_chat_stories?" + cleanupQuery, {
          method: "DELETE",
          headers: { apikey: key, Authorization: "Bearer " + key }
        });
        throw new Error("story_insert_returned_no_record");
      }

      const mediaUrl = await signedStoryUrl(path);

      if (!mediaUrl) {
        const cleanupQuery = new URLSearchParams({
          id: "eq." + story.id,
          owner_id: "eq." + ownerId
        });
        const cleanup = await fetch(
          base + "/rest/v1/arif_chat_stories?" + cleanupQuery,
          {
            method: "DELETE",
            headers: { apikey: key, Authorization: "Bearer " + key }
          }
        );
        if (!cleanup.ok) {
          console.error("ARIF_STORY_DB_CLEANUP_ERROR:", cleanup.status);
        }
        throw new Error("story_signed_url_failed");
      }

      return res.status(201).json({
        success: true,
        story: {
          id: story.id,
          media_type: story.media_type,
          caption: story.caption,
          created_at: story.created_at,
          expires_at: story.expires_at,
          media_url: mediaUrl
        }
      });
    } catch (e) {
      if (uploadedPath) await deleteStoryObject(uploadedPath);
      console.error("ARIF_STORY_CREATE_ERROR:", String(e.message || e).slice(0, 160));
      return res.status(503).json({
        success: false,
        message: "ثبت استوری ناموفق بود"
      });
    }
  });

  app.get("/api/chat/stories", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = auth(req, res);
    if (!session) return;

    try {
      const me = await currentUser(session);
      if (!me) {
        return res.status(404).json({
          success: false,
          message: "حساب کاربری پیدا نشد"
        });
      }

      const { base, key } = marketConfig();
      const q = new URLSearchParams({
        select: "id,owner_id,media_path,media_type,caption,created_at,expires_at",
        expires_at: "gt." + new Date().toISOString(),
        order: "created_at.desc",
        limit: "500"
      });

      const r = await fetch(base + "/rest/v1/arif_chat_stories?" + q, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });

      if (!r.ok) throw new Error("stories_read_failed");
      const rows = await r.json();
      const eligible = [];
      const permissionCache = new Map();

      for (const story of (Array.isArray(rows) ? rows : [])) {
        const ownerId = Number(story.owner_id);
        if (!permissionCache.has(ownerId)) {
          permissionCache.set(
            ownerId,
            canViewStories(ownerId, Number(me.id))
          );
        }

        if (!(await permissionCache.get(ownerId))) continue;

        const mediaUrl = await signedStoryUrl(story.media_path);
        if (!mediaUrl) continue;

        eligible.push({
          id: story.id,
          owner_id: ownerId,
          media_type: story.media_type,
          caption: story.caption || "",
          created_at: story.created_at,
          expires_at: story.expires_at,
          media_url: mediaUrl
        });
      }

      return res.json({ success: true, current_user_id: Number(me.id), stories: eligible });
    } catch (e) {
      console.error("ARIF_STORIES_READ_ERROR:", String(e.message || e).slice(0, 150));
      return res.status(503).json({
        success: false,
        message: "دریافت استوری‌ها ناموفق بود"
      });
    }
  });

  app.delete("/api/chat/stories/:id", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = auth(req, res);
    if (!session) return;

    try {
      const storyId = Number(req.params.id);
      if (!Number.isSafeInteger(storyId) || storyId <= 0) {
        return res.status(400).json({
          success: false,
          message: "شناسه استوری معتبر نیست"
        });
      }

      const me = await currentUser(session);
      if (!me) {
        return res.status(404).json({
          success: false,
          message: "حساب کاربری پیدا نشد"
        });
      }

      const { base, key } = marketConfig();
      const q = new URLSearchParams({
        select: "id,owner_id,media_path",
        id: "eq." + storyId,
        owner_id: "eq." + Number(me.id),
        limit: "1"
      });

      const r = await fetch(base + "/rest/v1/arif_chat_stories?" + q, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });

      if (!r.ok) throw new Error("story_delete_lookup_failed");
      const rows = await r.json();
      const story = Array.isArray(rows) ? rows[0] : null;

      if (!story) {
        return res.status(404).json({
          success: false,
          message: "استوری پیدا نشد"
        });
      }

      const del = await fetch(
        base + "/rest/v1/arif_chat_stories?id=eq." + storyId +
          "&owner_id=eq." + Number(me.id),
        {
          method: "DELETE",
          headers: { apikey: key, Authorization: "Bearer " + key }
        }
      );

      if (!del.ok) throw new Error("story_delete_failed");
      await deleteStoryObject(story.media_path);

      return res.json({ success: true, deleted: true });
    } catch (e) {
      console.error("ARIF_STORY_DELETE_ERROR:", String(e.message || e).slice(0, 150));
      return res.status(503).json({
        success: false,
        message: "حذف استوری ناموفق بود"
      });
    }
  });

  async function cleanupExpiredStories() {
    if (cleanupRunning) return;
    cleanupRunning = true;

    try {
      const { base, key } = marketConfig();
      const now = new Date().toISOString();
      const q = new URLSearchParams({
        select: "id,media_path",
        expires_at: "lt." + now,
        order: "expires_at.asc",
        limit: "100"
      });

      const r = await fetch(base + "/rest/v1/arif_chat_stories?" + q, {
        headers: { apikey: key, Authorization: "Bearer " + key }
      });

      if (!r.ok) throw new Error("expired_stories_read_failed");
      const rows = await r.json();
      let deleted = 0;

      for (const story of (Array.isArray(rows) ? rows : [])) {
        if (!(await deleteStoryObject(story.media_path))) continue;

        const dq = new URLSearchParams({
          id: "eq." + story.id,
          expires_at: "lt." + now
        });

        const dr = await fetch(
          base + "/rest/v1/arif_chat_stories?" + dq,
          {
            method: "DELETE",
            headers: { apikey: key, Authorization: "Bearer " + key }
          }
        );

        if (dr.ok) deleted++;
      }

      if (deleted) {
        console.log("ARIF_STORY_EXPIRY_CLEANUP: deleted=" + deleted);
      }
    } catch (e) {
      console.error("ARIF_STORY_CLEANUP_ERROR:", String(e.message || e).slice(0, 140));
    } finally {
      cleanupRunning = false;
    }
  }

  void cleanupExpiredStories();
  setInterval(() => void cleanupExpiredStories(), 5 * 60 * 1000);

  console.log("ARIF_CHAT_STORIES_API_V1 registered");
};
