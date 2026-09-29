-- رقمٌ سري ضعيف (9999 · 1234 · 0000 …) يُغيَّر قبل العمل (المرجع 5.2.0: ForcePinChangeSheet).
-- الخادم يعرف الرقم لحظة الدخول وحدها: يُعلَّم هنا فيبقى الطلب قائمًا بعد تحديث الصفحة.
alter table users add column if not exists must_change_pin boolean not null default false;
alter table users add column if not exists pin_changed_at timestamptz;
