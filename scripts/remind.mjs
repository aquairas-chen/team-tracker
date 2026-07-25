// 每日微信提醒（GitHub Actions 运行）
// 解密 data.enc → 计算「未启动 / 临期 / 延期」任务 → Server酱推送
// 管理员收到全量清单；成员名单里配置了 sendKey 的，额外收到只含自己任务的清单
const PW = process.env.VIEW_PW || "";
const KEY = process.env.SCT_KEY || "";
const REPO = process.env.GITHUB_REPOSITORY || "aquairas-chen/team-tracker";
const GT = process.env.GITHUB_TOKEN || "";
const SITE = "https://aquairas-chen.github.io/team-tracker/";

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

// 与网页一致的时间基准自动进度
function timeP(t) {
  const s = pd(t.start), e = pd(t.end);
  if (today <= s) return 0;
  const total = Math.max(Math.round((e - s) / DAY) + 1, 1);
  const gone = Math.round((today - s) / DAY) + 1;
  return Math.max(0, Math.min(99, Math.round(gone / total * 100)));
}

async function sendSCT(key, title, desp) {
  const r = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "title=" + encodeURIComponent(title) + "&desp=" + encodeURIComponent(desp)
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error("Server酱推送失败: " + JSON.stringify(j));
}

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
          } else {
            Object.keys(j.completions || {}).forEach(t => doneByMember[t] = true);
            Object.keys(j.started || {}).forEach(t => startedByMember[t] = true);
            (j.alerts || []).forEach(a => { if (!resolved.has(a.id)) openAlerts.push(a); });
          }
        } catch (e) {}
      }
    }
  }
  openAlerts = openAlerts.filter(a => !resolved.has(a.id));

  // 3. 有效进度（与网页 effP 一致）
  const autoP = db.autoP !== false;
  const isDone = t => (t.p || 0) >= 100 || !!doneByMember[t.id];
  const effP = t => {
    if (isDone(t)) return 100;
    const manual = t.p || 0;
    if (!autoP) return manual;
    if (manual > 0 || startedByMember[t.id]) return Math.max(manual, timeP(t));
    return 0;
  };

  // 4. 分类规则（与网页一致）
  const tasks = db.tasks || [];
  const stalled = tasks.filter(t => today > pd(t.start) && !isDone(t) && effP(t) === 0 && !startedByMember[t.id]);
  const upcoming = tasks.filter(t => {
    const left = Math.round((pd(t.end) - today) / DAY);
    return left >= 0 && left <= 3 && !isDone(t) && effP(t) < 50;
  });
  const overdue = tasks.filter(t => today > pd(t.end) && !isDone(t));

  const d = new Date(Date.now() + 8 * 3600e3);
  const dateLine = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

  function sectionLines(list, icon, label, whyFn) {
    if (!list.length) return [];
    const lines = [`### ${icon} ${label}（${list.length}）\n`];
    list.forEach(t => lines.push(`- **${t.name}**\n  > 👤 ${t.owner} ｜ ${whyFn(t)} ｜ 进度 ${effP(t)}% ｜ 截止 ${fmtD(pd(t.end))}`));
    return lines;
  }

  // 5. 管理员全量消息
  let title, desp;
  const total = stalled.length + upcoming.length + overdue.length;
  if (!total && !openAlerts.length) {
    title = `【项目日报】${dateLine} 全部按计划推进 ✅`;
    desp = "今日无「未启动 / 临期 / 延期」任务，也无未处理预警。\n\n继续保持！";
  } else {
    title = `【项目提醒】${dateLine} 未启动${stalled.length} 临期${upcoming.length} 延期${overdue.length} 预警${openAlerts.length}`;
    const lines = [];
    lines.push(...sectionLines(stalled, "🔴", "未启动（过开始日期仍 0%）", t => `已过开始 **${Math.round((today - pd(t.start)) / DAY)} 天**`));
    lines.push(...sectionLines(upcoming, "🟠", "临期 · 3天内截止", t => `还剩 **${Math.max(Math.round((pd(t.end) - today) / DAY), 0)} 天**`));
    lines.push(...sectionLines(overdue, "⛔", "已延期", t => `已过截止 **${Math.round((today - pd(t.end)) / DAY)} 天**`));
    if (openAlerts.length) {
      lines.push("\n### ⚠️ 成员预警\n");
      openAlerts.slice(0, 10).forEach(a => lines.push(`- ${a.name}：${a.reason}`));
    }
    lines.push(`\n> [打开追踪页面处理](${SITE})`);
    desp = lines.join("\n");
  }

  console.log("===== 管理员消息预览 =====");
  console.log(title);
  console.log(desp);

  if (!KEY) {
    console.log("SCT_KEY 未配置，跳过管理员推送");
  } else {
    await sendSCT(KEY, title, desp);
    console.log("✅ 管理员微信推送成功");
  }

  // 6. 成员个人推送（名单里配了 sendKey 的）
  const members = (db.members || []).filter(m => m.sendKey);
  for (const m of members) {
    try {
      const my = tasks.filter(t => (t.owner || "").includes(m.name));
      const mStalled = my.filter(t => stalled.includes(t));
      const mUpcoming = my.filter(t => upcoming.includes(t));
      const mOverdue = my.filter(t => overdue.includes(t));
      if (!mStalled.length && !mUpcoming.length && !mOverdue.length) {
        console.log(`-- ${m.name} 无待办提醒，跳过`);
        continue;
      }
      const mTitle = `【你的任务提醒】${dateLine} ${m.name}：未启动${mStalled.length} 临期${mUpcoming.length} 延期${mOverdue.length}`;
      const lines = [];
      lines.push(...sectionLines(mStalled, "🔴", "未启动", t => `已过开始 **${Math.round((today - pd(t.start)) / DAY)} 天**`));
      lines.push(...sectionLines(mUpcoming, "🟠", "临期", t => `还剩 **${Math.max(Math.round((pd(t.end) - today) / DAY), 0)} 天**`));
      lines.push(...sectionLines(mOverdue, "⛔", "已延期", t => `已过截止 **${Math.round((today - pd(t.end)) / DAY)} 天**`));
      lines.push(`\n> 消除方式：打开网页标记「进行中」或更新进度\n> [打开追踪页面](${SITE})`);
      console.log(`===== ${m.name} 消息预览 =====`);
      console.log(mTitle);
      console.log(lines.join("\n"));
      await sendSCT(m.sendKey, mTitle, lines.join("\n"));
      console.log(`✅ ${m.name} 推送成功`);
    } catch (e) {
      console.error(`⚠️ ${m.name} 推送失败（不影响其他人）：`, e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
