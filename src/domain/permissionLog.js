/**
 * سجل الصلاحيات (buildPermissionLog في المرجع) — يُسجَّل **الفرق** لا
 * الحالة: «أُضيفت له إخراج القطع وحُذف منه الجرد» يُنبئ، و«صار له 42
 * شاشة» لا يُنبئ. وسؤالٌ يُسأل بعد كل اختلاس: من أعطى فلانًا هذه
 * الصلاحية ومتى؟ — ولا جواب إن لم يُسجَّل المنح نفسه.
 */
async function logPermission(client, branchId, { targetId = null, targetName = null, kind, before = null, after = null, added = null, removed = null, actor = {} }) {
  await client.query(
    `insert into permission_log
       (branch_id, target_id, target_name, kind, before, after, added, removed, actor_id, actor_name, actor_kind)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      branchId, targetId, targetName, kind,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
      added == null ? null : JSON.stringify(added), removed == null ? null : JSON.stringify(removed),
      actor.kind === "branch" || actor.kind === "self" ? actor.id || null : null,
      actor.name || null, actor.kind || "branch",
    ]
  );
}

function diffPages(before = [], after = []) {
  const b = new Set(before || []);
  const a = new Set(after || []);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}

export { logPermission, diffPages };
