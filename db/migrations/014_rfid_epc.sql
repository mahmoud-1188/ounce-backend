-- 014_rfid_epc.sql
--
-- يضيف عمود ربط بطاقة RFID (EPC) لكل قطعة، لدعم قارئ NHR-10 (البلوتوث)
-- وقارئات الباركود/RFID بنمط HID (لوحة مفاتيح) على حدٍّ سواء — كلاهما
-- ينتهي بنفس النص: رمز EPC يُطابَق بوحدة (item_unit) بعينها.
--
-- ⚠ فريد على مستوى الجدول كلّه لا الفرع: بطاقة RFID فعلية واحدة لا
-- يُعقَل أن تُربط بقطعتين حتى لو في فرعين مختلفين — لو حدث لالتبس
-- أيّهما بيعت عند القراءة. item_units أصلًا بلا عمود branch_id (يُعرف
-- فرعها عبر items عند كل استعلام)، فإضافة عمودٍ هنا فقط من أجل هذا
-- القيد كانت ستُكرّر بيانات items.branch_id بلا داعٍ — index جزئي على
-- epc وحدها يكفي ويطابق نمط الجدول الحالي.
alter table item_units add column if not exists epc text;
alter table item_units add column if not exists epc_bound_at timestamptz;
alter table item_units add column if not exists epc_bound_by uuid references users(id);

-- ⚠ index جزئي (epc is not null) لا فهرس كامل: أغلب الوحدات لن تُربط
-- ببطاقة أبدًا (المتاجر تبدأ تدريجيًا)، وفهرسة NULL لكل تلك الصفوف هدر.
create unique index if not exists item_units_epc_uq
  on item_units (epc) where epc is not null;

-- شاشتا "قارئ RFID"/"إعدادات القارئ" جديدتان في allowed_more — بنفس
-- منطق "printerSetup" تمامًا: صفحة يحكمها الفرونت إند فقط (لا
-- requirePage خاص بها، القارئ جهازٌ محلي بحت)، والحارس الفعلي على
-- الخادم هو /rfid/bind بصفحات الاستخدام الفعلية (addGoods/stocktake/…
-- — انظر rfid.routes.js). نضيفها لصلاحيات المدير الافتراضية فقط، تمامًا
-- كما أُضيفت printerSetup أصلًا في migration 002 — لا رجوعًا بأثر رجعي
-- على مستخدم له allowed_pages مخصّصة (نفس القيد القائم أصلًا على أي
-- صفحة جديدة تُضاف لاحقًا؛ من يريدها لموظف بعينه يفعّلها من "صلاحيات
-- الوصول" كأي صفحة أخرى).
update roles
   set allowed_more = allowed_more || '["rfidReader","rfidSettings"]'::jsonb
 where id = 'manager'
   and not (allowed_more @> '["rfidReader"]'::jsonb);
