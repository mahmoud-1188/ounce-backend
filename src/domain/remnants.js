import { cleanSetParts } from "./setParts.js";

/**
 * تكويد بقايا طقم (المرجع 5.2.0: RemnantCodingForm) — مشتركٌ بين الفرع (POST /items/:id/code-remnant)
 * والإدارة (POST /store/branches/:branchId/remnants/:itemId/code): قطعٌ مجموع أوزانها وزنُ البقايا
 * بتكلفة جرامها، ومصنعيّتها موزّعةٌ بالوزن. الذهب لا يغادر 1210 فلا قيد ولا حركة وزن.
 */
async function codeRemnant(client, { branchId, itemId, pieces, userId = null, by = null }) {
  const { rows } = await client.query(
    "select * from items where id = $1 and branch_id = $2 for update", [itemId, branchId]);
  const rem = rows[0];
  if (!rem) return { error: "item_not_found" };
  if (!rem.remnant) return { error: "not_a_remnant" };
  const { rows: units } = await client.query(
    "select id from item_units where item_id = $1 and sold = false and issued = false", [rem.id]);
  if (!units.length) return { error: "remnant_not_owned" };

  const w3 = (x) => Math.round(Number(x) * 1000);
  const totalMg = pieces.reduce((a, p) => a + w3(p.weight), 0);
  if (totalMg !== w3(rem.weight)) {
    return { error: "weights_must_equal_remnant", remnantWeight: Number(rem.weight), piecesWeight: totalMg / 1000 };
  }

  const { rows: catRows } = await client.query(
    "select id from categories where branch_id = $1 or branch_id is null", [branchId]);
  const valid = new Set(catRows.map((c) => c.id));
  if (pieces.some((p) => !valid.has(p.categoryId))) return { error: "category_not_found" };

  // المصنعية بالوزن، والهللة الباقية على آخر قطعة فيبقى المجموع كما كان
  const wmH = Math.round((Number(rem.workmanship) || 0) * 100);
  let usedH = 0;
  const created = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const shareH = i === pieces.length - 1 ? wmH - usedH : Math.round((wmH * w3(p.weight)) / totalMg);
    usedH += shareH;
    const { rows: cnt } = await client.query("select count(*)::int + 1 as n from items where branch_id = $1", [branchId]);
    const ref = `ITM-${String(cnt[0].n).padStart(6, "0")}`;
    const { rows: ni } = await client.query(
      `insert into items (branch_id, ref, lot_id, category_id, karat, weight, cost_per_gram, workmanship,
                          created_by, remnant_of, set_parts)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, ref, category_id, karat, weight, workmanship`,
      [branchId, ref, rem.lot_id, p.categoryId, rem.karat, w3(p.weight) / 1000, rem.cost_per_gram,
        shareH / 100, userId, rem.id, JSON.stringify(cleanSetParts(p.setParts))]
    );
    await client.query("insert into item_units (item_id, code) values ($1, $2)", [ni[0].id, ref]);
    created.push({ ...ni[0], code: ref });
  }
  await client.query(
    "update item_units set issued = true, issued_at = now(), issued_by = $2 where id = any($1::uuid[])",
    [units.map((u) => u.id), userId]
  );
  await client.query("update items set remnant = false where id = $1", [rem.id]);
  await client.query(
    `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
     values ($1,'update',$2,'items',$3,$4)`,
    [branchId, userId, rem.id, JSON.stringify({ ...(by ? { by, byKind: "store" } : {}), codedRemnant: rem.ref, weight: Number(rem.weight), pieces: created.map((c) => c.code) })]
  );
  return { items: created };
}

/** بقايا الأطقم المملوكة في الفرع — لقائمة التكويد في الفرع والإدارة. */
async function listRemnants(client, branchId) {
  const { rows } = await client.query(
    `select i.id, i.ref, i.karat, i.weight::float as weight, i.workmanship::float as workmanship, i.set_parts, i.remnant_of,
            (select u.code from item_units u where u.item_id = i.id and u.sold = false and u.issued = false limit 1) as code
       from items i
      where i.branch_id = $1 and i.remnant = true
        and exists (select 1 from item_units u where u.item_id = i.id and u.sold = false and u.issued = false)
      order by i.date_added desc`, [branchId]);
  return rows.map((r) => ({ id: r.id, ref: r.ref, code: r.code, karat: r.karat, weight: r.weight, workmanship: r.workmanship, setParts: r.set_parts || [], remnantOf: r.remnant_of }));
}

export { codeRemnant, listRemnants };
