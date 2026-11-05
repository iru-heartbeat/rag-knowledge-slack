-- 6部署のマスタ。名前は文書内の部署記載と照合する（接尾辞「部」などは除いた形で登録）
insert into departments (name) values ('戦略'), ('業務'), ('IT'), ('人事'), ('営業'), ('管理')
on conflict (name) do nothing;
