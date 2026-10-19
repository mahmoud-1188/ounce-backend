-- إعادة طباعة ملصقٍ طُبع من قبل أو استبدال رقاقته تحتاج اعتمادًا — فلا يُطبع ملصقٌ ثانٍ لقطعةٍ بلا أثر.
-- الحدّ صفر: كل طلبٍ يُعتمد (المدير يعتمد نفسه ويُسجَّل، أو الإدارة إن جعلته لها في «من يعتمد ماذا»).
insert into approval_rules (id, label, threshold, approver_role) values
  ('label_reprint', 'إعادة طباعة ملصق أو استبدال رقاقة', 0, 'manager')
on conflict (id) do nothing;
