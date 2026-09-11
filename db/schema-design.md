# تصميم قاعدة البيانات (PostgreSQL / Supabase) — تطبيق أونصة

هذا المستند يحوّل `data-model-spec.md` + الملفات المرجعية الفعلية (`keys.js`, `chart.js`, `erp.js`, `money.js`) إلى تصميم جداول SQL قابل للتنفيذ المباشر على PostgreSQL عبر Supabase. الملف التالي `schema.sql` يحتوي أوامر `CREATE TABLE` الفعلية المطابقة لهذا التصميم.

**مصدر كل قرار هنا هو الكود الفعلي المفحوص، لا اجتهاد جديد.**

---

## 0. قرارات جوهرية قبل الجداول

### 0.1 المال والوزن: أعداد صحيحة بالوحدة الصغرى، لا `FLOAT`

من `money.js`: التطبيق يخزّن كل مبلغ **بالهللة** (÷100) وكل وزن **بالملي** (÷1000) كأعداد صحيحة، تحديدًا لتفادي أخطاء التقريب في الفاصلة العائمة (`0.1 + 0.2 = 0.30000000000000004`). هذا قرار محاسبي حرج موثّق بتعليقات صريحة في الكود ("الهللة تضيع، ثم تتراكم عبر آلاف الأسطر").

**الأثر على Schema**: كل عمود مالي يُخزَّن كـ `NUMERIC(14,2)` (وليس `FLOAT`/`REAL` أبدًا — `FLOAT` في PostgreSQL نفسه عرضة لنفس مشكلة الفاصلة العائمة)، وكل عمود وزني كـ `NUMERIC(12,3)`. هذا يحافظ حرفيًا على نفس دقة التطبيق الحالي (هللتان بعد الفاصلة للمال، ثلاث خانات ملّي للوزن) والقاعدة نفسها تمنع فقدان الدقة، فلا نحتاج نعيد بناء طبقة `toMinor/fromMinor` في الباك إند — القاعدة تضمنها.

### 0.2 معرّفات السجلات: `UUID` + رقم مرجعي منفصل

كل كيان في الكود له معرّف داخلي (`id`) ورقم مرجعي مقروء (`ref`, مثل `SUP-014`). نستخدم:
- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` — المعرّف الداخلي.
- `ref TEXT UNIQUE` — الرقم المرجعي، يُولَّد بتسلسل منفصل لكل نوع كيان (فاتورة، مورد، دفعة...).

### 0.3 الفروع (Multi-Branch) من أول عمود

بما إن الكود عنده مفهوم فرع/HQ جاهز (`BRANCH_IDENTITY_KEY`, `HQ_BRANCH_REGISTRY_KEY`) وناقشنا سابقًا أن هذا القرار لازم يُتخذ من البداية، **كل جدول عملياتي يحمل `branch_id`** من أول يوم، مع Row Level Security (RLS) في Supabase تفرض عزل كل فرع عن غيره تلقائيًا على مستوى القاعدة نفسها — وهذا أقوى من فرضه في كود الباك إند فقط.

### 0.4 القيد المزدوج: جدول قيود + جدول أسطر، بقيد `CHECK` يفرض التوازن

`JOURNAL_KEY` + `POSTING_RULES` في `erp.js`/`chart.js` يوضحان: كل عملية تُنشئ قيدًا واحدًا بعدة أسطر (سطر مدين وسطر دائن على الأقل)، ومجموع المدين يجب يساوي مجموع الدائن. نبني هذا كجدولين (`journal_entries` + `journal_lines`) مع `trigger` (لا `CHECK` بسيط، لأن التوازن يحتاج جمع كل الأسطر) يمنع أي قيد غير متوازن من الحفظ نهائيًا — **إنفاذ صارم في القاعدة نفسها، مو فقط في كود الواجهة**.

### 0.5 دفتر الوزن مستقل تمامًا عن دفتر النقد

من `money.js` صراحة: "دفتر الوزن ودفتر النقد كيانان مستقلان: لكلٍّ حساباته وقواعده وميزان مراجعته. لا يُجمعان في رقم واحد." لذلك `gold_ledger_entries` جدول منفصل تمامًا عن `journal_lines`، بعمود وزن فقط (`NUMERIC(12,3)`) بلا أي عمود مالي.

---

## 1. شجرة الحسابات (Chart of Accounts)

جدول واحد ثابت شبه-تعريفي (Reference Table)، مطابق حرفيًا لـ`CHART_OF_ACCOUNTS` في `chart.js` (80+ حساب).

```
accounts
├─ code          TEXT PRIMARY KEY       -- "1110", "4140", ...
├─ name          TEXT NOT NULL
├─ parent_code   TEXT REFERENCES accounts(code)
├─ unit          TEXT CHECK (unit IN ('currency','gram','both'))
├─ nature        TEXT CHECK (nature IN ('debit','credit'))
├─ statement     TEXT CHECK (statement IN ('balance','income','offBalance'))
├─ is_group      BOOLEAN DEFAULT false  -- حساب أب تجميعي، لا تُرحَّل عليه قيود مباشرة
├─ pool          TEXT                   -- 'safe' | 'daily' | 'custody' (لحسابات النقد فقط)
├─ method        TEXT                   -- 'cash' | 'network' (لحسابات النقد فقط)
└─ note          TEXT
```

يُعبَّأ هذا الجدول ببيانات ثابتة (seed data) من `CHART_OF_ACCOUNTS` مباشرة عند إنشاء القاعدة — سكربت تحويل بسيط من مصفوفة JS إلى `INSERT` statements.

**جدول مرافق**: `posting_rules` يخزّن `POSTING_RULES` (نوع العملية ← الحسابات المدينة/الدائنة الافتراضية) كبيانات JSON مرجعية، يستخدمها الباك إند وقت إنشاء أي قيد تلقائي، بدل تكرار المنطق كشرط برمجي متفرق.

---

## 2. القيد المزدوج (دفتر النقد)

```
journal_entries
├─ id               UUID PK
├─ branch_id        UUID NOT NULL REFERENCES branches(id)
├─ business_day_id  UUID REFERENCES business_days(id)
├─ op_type          TEXT NOT NULL        -- 'sale_cash', 'purchase_deferred', ... (مفتاح posting_rules)
├─ ref_table        TEXT                 -- اسم الجدول المصدر (اختياري، للتتبع)
├─ ref_id           UUID                 -- معرّف السجل المصدر (الفاتورة مثلاً)
├─ description      TEXT
├─ created_by       UUID REFERENCES users(id)
├─ created_at       TIMESTAMPTZ DEFAULT now()
└─ reversed_of      UUID REFERENCES journal_entries(id)  -- للقيد العكسي (reverse)

journal_lines
├─ id               UUID PK
├─ entry_id         UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE
├─ account_code     TEXT NOT NULL REFERENCES accounts(code)
├─ side             TEXT CHECK (side IN ('debit','credit'))
└─ amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0)
```

**Trigger إلزامي**: `AFTER INSERT OR UPDATE OR DELETE ON journal_lines` يتحقق أن `SUM(amount) WHERE side='debit'` يساوي `SUM(amount) WHERE side='credit'` لنفس `entry_id`، ويرفض العملية (`RAISE EXCEPTION`) لو لم يتوازن — هذا يطبّق نفس القاعدة اللي فرضها `erp.js` لكن على مستوى القاعدة، فيستحيل تمريرها حتى لو فيه خطأ مستقبلي في كود الباك إند.

---

## 3. دفتر الوزن (مستقل)

```
gold_ledger_entries
├─ id               UUID PK
├─ branch_id        UUID NOT NULL REFERENCES branches(id)
├─ business_day_id  UUID REFERENCES business_days(id)
├─ op_type          TEXT NOT NULL
├─ karat            SMALLINT NOT NULL CHECK (karat IN (24,22,21,18,14))
├─ weight           NUMERIC(12,3) NOT NULL       -- الوزن الفعلي بالعيار
├─ fine_weight       NUMERIC(12,3) NOT NULL       -- معادل عيار 24 (weight × نقاوة العيار)
├─ from_account     TEXT REFERENCES accounts(code)  -- يخرج منه (nullable لدخول خارجي)
├─ to_account       TEXT REFERENCES accounts(code)  -- يدخل فيه (nullable لخروج نهائي)
├─ ref_table        TEXT
├─ ref_id           UUID
├─ note             TEXT
├─ created_by       UUID REFERENCES users(id)
└─ created_at       TIMESTAMPTZ DEFAULT now()
```

**قيد**: `CHECK (from_account IS NOT NULL OR to_account IS NOT NULL)` — سطر بلا مصدر ولا وجهة غير منطقي، ونتحقق أيضًا أن أي حساب مذكور موجود ضمن `WEIGHT_ACCOUNTS` (١٢١٠، ١٢٢٠، ١٢٣٠، ١٢٤٠، ٢١١٠، ٧١٠٠، ٧٢٠٠) عبر قيد `CHECK ... IN (...)` مطابق تمامًا للمصفوفة في `chart.js`.

---

## 4. الصندوق (Cash Ledger) — ثلاث برك منفصلة

```
cash_tx
├─ id               UUID PK
├─ branch_id        UUID NOT NULL REFERENCES branches(id)
├─ business_day_id  UUID REFERENCES business_days(id)
├─ pool             TEXT CHECK (pool IN ('safe','daily','custody'))
├─ method           TEXT CHECK (method IN ('cash','network'))
├─ direction        TEXT CHECK (direction IN ('in','out'))
├─ amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0)
├─ category         TEXT NOT NULL           -- مفتاح CATEGORY_TO_ACCOUNT
├─ note             TEXT
├─ ref_table        TEXT
├─ ref_id           UUID
├─ created_by       UUID REFERENCES users(id)
└─ created_at       TIMESTAMPTZ DEFAULT now()
```

---

## 5. يوم العمل (Business Day)

```
business_days
├─ id            UUID PK
├─ branch_id     UUID NOT NULL REFERENCES branches(id)
├─ ref           TEXT UNIQUE NOT NULL
├─ status        TEXT CHECK (status IN ('open','closed')) DEFAULT 'open'
├─ till_float    NUMERIC(14,2) DEFAULT 0     -- الرصيد الافتتاحي للدرج
├─ scrap_float   NUMERIC(14,2) DEFAULT 0     -- الرصيد الافتتاحي لعهدة الكسر
├─ opened_by     UUID REFERENCES users(id)
├─ opened_at     TIMESTAMPTZ NOT NULL
├─ closed_by     UUID REFERENCES users(id)
└─ closed_at     TIMESTAMPTZ

stocktake_locks
├─ id            UUID PK
├─ branch_id     UUID NOT NULL REFERENCES branches(id)
├─ locked        BOOLEAN DEFAULT false
├─ locked_by     UUID REFERENCES users(id)
└─ locked_at     TIMESTAMPTZ
```

**قيد تطبيقي مهم (يُفرض في الباك إند، لا في القاعدة)**: أي محاولة `INSERT` في `sales`/`items` وقت `stocktake_locks.locked = true` لنفس الفرع تُرفض من الـAPI — هذا نفس منطق "قفل الجرد" الموجود في الفرونت إند حاليًا.

---

## 6. الأصناف والوحدات (Items)

```
categories
├─ id             UUID PK
├─ branch_id      UUID REFERENCES branches(id)   -- null = تصنيف عام لكل الفروع
├─ name           TEXT NOT NULL
├─ sale_mode      TEXT CHECK (sale_mode IN ('whole','partial','set'))
└─ min_sale_weight NUMERIC(12,3)                  -- للبيع الجزئي (سبيكة مثلاً)

lots
├─ id             UUID PK
├─ branch_id      UUID NOT NULL REFERENCES branches(id)
├─ ref            TEXT UNIQUE NOT NULL
├─ supplier_id    UUID REFERENCES suppliers(id)
├─ date           DATE NOT NULL
└─ created_by     UUID REFERENCES users(id)

items
├─ id                     UUID PK
├─ branch_id              UUID NOT NULL REFERENCES branches(id)
├─ ref                    TEXT UNIQUE NOT NULL
├─ lot_id                 UUID REFERENCES lots(id)
├─ category_id            UUID NOT NULL REFERENCES categories(id)
├─ karat                  SMALLINT NOT NULL CHECK (karat IN (24,22,21,18,14))
├─ weight                 NUMERIC(12,3) NOT NULL      -- الوزن الحالي (ينقص تدريجيًا في partial)
├─ stones_weight          NUMERIC(12,3) DEFAULT 0
├─ cost_per_gram          NUMERIC(14,4)               -- تكلفة الشراء وقت الإدخال
├─ workmanship            NUMERIC(14,2) DEFAULT 0
├─ lot_workmanship_share  NUMERIC(14,2) DEFAULT 0
├─ from_scrap             BOOLEAN DEFAULT false
├─ date_added             TIMESTAMPTZ DEFAULT now()
├─ business_day_id        UUID REFERENCES business_days(id)
└─ created_by             UUID REFERENCES users(id)

item_units
├─ id           UUID PK
├─ item_id      UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE
├─ code         TEXT UNIQUE NOT NULL      -- كود القطعة الفردية (باركود/رقاقة)
├─ printed      BOOLEAN DEFAULT false
└─ sold         BOOLEAN DEFAULT false
```

**ملاحظة حرجة من `data-model-spec.md`**: الفرق بين `whole`/`partial`/`set` جوهري ولا يجوز خلطه في منطق التطبيق ("بيع سبيكة كقطعة كاملة = بيع 1000جم لمن طلب جرامًا"). هذا يُفرض في **منطق الباك إند** (endpoint البيع يتصرف مختلفًا حسب `category.sale_mode`)، القاعدة نفسها تخزّن القيمة فقط.

---

## 7. المبيعات

```
sales
├─ id                   UUID PK
├─ branch_id            UUID NOT NULL REFERENCES branches(id)
├─ ref                  TEXT UNIQUE NOT NULL
├─ business_day_id      UUID NOT NULL REFERENCES business_days(id)
├─ date                 TIMESTAMPTZ DEFAULT now()
├─ customer_id          UUID REFERENCES customers(id)
├─ customer_name        TEXT
├─ payment_method       TEXT CHECK (payment_method IN ('cash','card','credit','split'))
├─ price24_snapshot     NUMERIC(14,4) NOT NULL     -- سعر جرام عيار 24 وقت البيع (مجمّد)
├─ price_frozen_at      TIMESTAMPTZ
├─ card_network         TEXT
├─ cash_part            NUMERIC(14,2) DEFAULT 0
├─ network_part         NUMERIC(14,2) DEFAULT 0
├─ network_fee_pct      NUMERIC(6,4) DEFAULT 0
├─ subtotal             NUMERIC(14,2) NOT NULL
├─ total                NUMERIC(14,2) NOT NULL
├─ tax_applicable       BOOLEAN DEFAULT true
├─ tax_rate             NUMERIC(6,4) DEFAULT 0.15
├─ tax_amount           NUMERIC(14,2) DEFAULT 0
├─ net_amount           NUMERIC(14,2) NOT NULL
├─ seller_id            UUID REFERENCES users(id)
├─ seller_name          TEXT
└─ created_by           UUID REFERENCES users(id)

sale_lines
├─ id                       UUID PK
├─ sale_id                  UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE
├─ item_id                  UUID NOT NULL REFERENCES items(id)
├─ category                 TEXT
├─ karat                    SMALLINT
├─ quantity                 NUMERIC(12,3) NOT NULL   -- عدد قطع أو وزن جزئي
├─ unit_price               NUMERIC(14,2) NOT NULL   -- يُدخله البائع يدويًا
├─ weight_snapshot          NUMERIC(12,3)
├─ cost_per_gram_snapshot   NUMERIC(14,4)
└─ workmanship_snapshot     NUMERIC(14,2)
```

**نقاط حرجة موثّقة من `data-model-spec.md` تنعكس هنا**:
- `price24_snapshot` يُجمَّد وقت البيع، لا يُحسب من سعر السوق الحالي لاحقًا — ولذلك هو عمود مخزَّن، لا Computed Column.
- الضريبة "شاملة" (`tax_amount = total − total/(1+tax_rate)`) — هذا حساب يتم في الباك إند وقت الإدخال، يُخزَّن الناتج مباشرة، لا نعيد حسابه بمعادلة SQL كل قراءة.
- عند البيع، الباك إند (مو trigger) هو من يُحدّث `item_units.sold = true` ويُنشئ `journal_entries` + `gold_ledger_entries` معًا كعملية ذرية واحدة (transaction) — بالضبط زي `handleAddSafeGoldTx` في الفرونت إند الحالي.

---

## 8. الموردون والمشتريات والكسر

```
suppliers
├─ id            UUID PK
├─ branch_id     UUID NOT NULL REFERENCES branches(id)
├─ ref           TEXT UNIQUE NOT NULL
├─ name          TEXT NOT NULL
├─ phone         TEXT
├─ is_official   BOOLEAN DEFAULT false
├─ created_by    UUID REFERENCES users(id)
└─ created_at    TIMESTAMPTZ DEFAULT now()

-- التزام المورد ببُعدين منفصلين (من chart.js: 2110 ذهب / 2120 أجور)
supplier_gold_balance   -- View محسوبة من gold_ledger_entries WHERE account IN ('2110')
supplier_fee_balance    -- View محسوبة من journal_lines WHERE account = '2120'

scrap_items
├─ id            UUID PK
├─ branch_id     UUID NOT NULL REFERENCES branches(id)
├─ ref           TEXT UNIQUE NOT NULL
├─ supplier_id   UUID REFERENCES suppliers(id)
├─ karat_est     SMALLINT                     -- عيار تقديري قبل الفحص
├─ weight_est    NUMERIC(12,3)                -- وزن تقديري (يشمل فصوص/لحام)
├─ karat_final   SMALLINT                     -- بعد الفحص
├─ weight_final  NUMERIC(12,3)
├─ stage         TEXT CHECK (stage IN ('in_box','sent','assessed','approved','in_safe','used'))
├─ business_day_id UUID REFERENCES business_days(id)
└─ created_by    UUID REFERENCES users(id)
```

**قيد جوهري من `data-model-spec.md`** (سلسلة العهدة بست حالات): "لا يُسدَّد مورد إلا مما بلغ `in_safe`". هذا يُفرض في الباك إند: أي endpoint لسداد مورد بالكسر (`settle_scrap`) يتحقق أولًا أن `scrap_items.stage = 'in_safe'` قبل إنشاء القيد — ونضيف أيضًا قيد `CHECK` بسيط في القاعدة على `stage` نفسه لمنع أي قيمة خارج الحالات الست (موثّق أعلاه).

---

## 9. الأطراف الأخرى (جداول مباشرة، بنية مشابهة)

هذي الجداول أبسط بنيويًا (بلا منطق محاسبي معقّد إضافي)، فأذكرها مختصرة — التفاصيل الكاملة في `schema.sql`:

- `customers`, `partners`, `partner_tx`, `users` (مع `role`, `pin_hash`, `allowed_tabs`, `allowed_pages`)
- `taskir_offices`, `taskir_entries`, `taskir_office_tx`
- `safe_gold_tx` (إيداع/سحب ذهب الخزنة، بعمود `destination` إجباري عند السحب — من `erp.js`: "الوجهة إجبارية")
- `expenses`, `expense_names`
- `receipts` (سداد آجل), `returns` (مرتجعات), `reservations` (عرابين)
- `safe_audits` (جرد الخزنة الفعلي)
- `trust_accounts`, `trust_ledger` (ذهب الأمانة — حساب 7100 خارج الميزانية)
- `fixed_assets`, `depreciation_schedule`, `cost_centers`, `budgets`
- `payroll_runs`, `attendance`, `leave_requests` (مع `gosi_rates` كجدول مرجعي من `GOSI_RATES`)
- `approvals` (مطابق لـ`APPROVAL_RULES`: threshold + approver role)
- `audit_log` (أحداث معلنة من `AUDIT_EVENTS`، لا نص حر — `CHECK (event_type IN (...))`)
- `branches`, `hq_permissions` (متعدد الفروع)
- `opening_balances`, `fiscal_closures`, `period_closes`
- `webhooks`, `store_orders`, `integrations`, `ext_invoices`
- `commissions` (قواعد العمولة: `basis IN ('profit','sales')`, حسب `COMMISSION_BASES`)

---

## 10. الصور — منفصلة تمامًا عن القاعدة (تطبيقًا لطلب العميل)

لا عمود صورة (BLOB) في أي جدول أعلاه. كل مرجع صورة هو عمود `TEXT` واحد يحمل رابط Object Storage (مثال: `items.photo_url`, `scrap_items.photo_url`)، والصورة نفسها (بعد ضغطها وتحويلها WebP في خط الأنابيب الذي اتفقنا عليه) تعيش في Supabase Storage (أو أي S3-compatible) منفصل بالكامل.

---

## 11. الفهرسة (Indexes) الأساسية

على كل عمود `ref` (بحث يومي متكرر من كل شاشة تقريبًا)، وعلى كل `branch_id` + `business_day_id` مجتمعين (كل تقرير يومي يفلتر بهما)، وعلى `foreign key` الشائعة (`item_id`, `customer_id`, `supplier_id`). التفاصيل الكاملة في `schema.sql`.

---

## 12. Row Level Security (عزل الفروع)

Supabase تفعّل RLS على مستوى الجدول مباشرة. القاعدة الموحّدة على كل جدول عملياتي:

```sql
CREATE POLICY branch_isolation ON <table>
  USING (branch_id = current_setting('app.current_branch_id')::uuid);
```

الباك إند يضبط `app.current_branch_id` من الـJWT/الجلسة عند كل اتصال، فيستحيل على فرع يقرأ بيانات فرع آخر حتى لو صار خطأ برمجي في الباك إند — الحماية على مستوى القاعدة نفسها، تطبيقًا مباشرًا لمبدأ "العزل من أول سطر" الذي طلبه العميل.
