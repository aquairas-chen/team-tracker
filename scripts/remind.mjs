// 每日微信提醒（GitHub Actions 运行）
// 解密 data.enc → 计算「过了开始日期仍未启动」任务 → Server酱推送到管理员微信
const PW = process.env.VIEW_PW || "";
const KEY = process.env.SCT_KEY || "";
const REPO = process.env.GITHUB_REPOSITORY || "aquairas-chen/team-tracker";
const GT = process.env.GITHUB_TOKEN || "";

const DAY = 86400000;
const b2ab = b64 => new Uint8Array(Buffer.from(b64, "base64"));
const pd = s => { const p = s.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); };
const fmtD = d => (d.getUTCMonth() + 1) + "/" + d.getUTCDate();

async function deriveKey(pw, salt) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
}
async function decryptText(blob, pw) {
  const o = JSON.parse(blob);
  const key = await deriveKey(pw, b2ab(o.s));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b2ab(o.i) }, key, b2ab(o.d));
  return new TextDecoder().decode(pt);
}

// 北京时间“今天”
const nowUtc = new Date(Date.now() + 8 * 3600e3);
const today = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()));
const todayStr = fmtD(today);

async function main() {
  if (!PW) throw new Error("缺少 VIEW_PW secret");
  // 1. 读取加密计划
  const g = await fetch(`https://api.github.com/repos/${REPO}/contents/data.enc`, {
    headers: { Authorization: "Bearer " + GT, Accept: "application/vnd.github.raw+json" }
  });
  if (!g.ok) throw new Error("读取 data.enc 失败 HTTP " + g.status);
  const db = JSON.parse(await decryptText(await g.text(), PW));

  // 2. 读取反馈仓库（成员完成 / 进行中 / 预警）
  const doneByMember = {}, startedByMember = {}, resolved = new Set();
  let openAlerts = [];
  if (db.fbToken) {
    const fbBase = `https://api.github.com/repos/${REPO}-feedback/contents`;
    const fh = { Authorization: "Bearer " + db.fbToken };
    const lf = await fetch(fbBase, { headers: fh });
    if (lf.ok) {
      const files = await lf.json();
      for (const f of files) {
        if (!/^m_.*\.json$/.test(f.name) && f.name !== "control.json") continue;
        const rr = await fetch(`${fbBase}/${f.name}`, { headers: { ...fh, Accept: "application/vnd.github.raw+json" } });
        if (!rr.ok) continue;
        try {
          const j = JSON.parse(await rr.text());
          if (f.name === "control.json") {
            (j.resolvedAlerts || []).forEach(id => resolved.add(id));
            Object.assign(doneByMember, {});
          } else {
            Object.keys(j.completions || {}).forEach(t => doneByMember[t] = true);
            Object.keys(j.started || {}).forEach(t => startedByMember[t] = true);
            (j.alerts || []).forEach(a => { if (!resolved.has(a.id)) openAlerts.push(a); });
          }
        } catch (e) {}
      }
    }
  }

  // 3. 计算未启动清单（与网页逻辑一致：过开始日期、未完成、进度0、未标记进行中）
  const stalled = (db.tasks || []).filter(t => {
    const done = (t.p || 0) >= 100 || doneByMember[t.id];
    return today > pd(t.start) && !done && (t.p || 0) === 0 && !startedByMember[t.id];
  }).map(t => ({
    name: t.name, owner: t.owner,
    days: Math.round((today - pd(t.start)) / DAY),
    end: fmtD(pd(t.end))
  }));
  openAlerts = openAlerts.filter(a => !resolved.has(a.id));

  // 4. 组装微信消息
  let title, desp;
  const d = new Date(Date.now() + 8 * 3600e3);
  const dateLine = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (!stalled.length && !openAlerts.length) {
    title = `【项目日报】${dateLine} 全部按计划推进 ✅`;
    desp = `今日无「过了开始日期仍未启动」的任务，也无未处理预警。\n\n继续保持！`;
  } else {
    title = `【项目提醒】${dateLine} 未启动 ${stalled.length} 项 · 预警 ${openAlerts.length} 条`;
    const lines = [];
    if (stalled.length) {
      lines.push("### 🔴 未启动任务（过开始日期，进度仍 0%）\n");
      stalled.forEach(t => lines.push(`- **${t.name}**\n  > 👤 ${t.owner} ｜ 已过开始日期 **${t.days} 天** ｜ 截止 ${t.end} ｜ [网页](https://aquairas-chen.github.io/team-tracker/)`));
    }
    if (openAlerts.length) {
      lines.push("\n### ⚠️ 成员预警\n");
      openAlerts.slice(0, 10).forEach(a => lines.push(`- ${a.name}：${a.reason}`));
    }
    lines.push("\n> 消除方式：进度 >0%、标记「进行中」或「完成」");
    desp = lines.join("\n");
  }

  console.log("===== 消息预览 =====");
  console.log(title);
  console.log(desp);

  // 5. 推送（Server酱）
  if (!KEY) {
    console.log("SCT_KEY 未配置，跳过推送（配置后自动发送）");
    return;
  }
  const r = await fetch(`https://sctapi.ftqq.com/${KEY}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "title=" + encodeURIComponent(title) + "&desp=" + encodeURIComponent(desp)
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error("Server酱推送失败: " + JSON.stringify(j));
  console.log("✅ 微信推送成功");
}

main().catch(e => { console.error(e); process.exit(1); });
