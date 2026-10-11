-- 图片规格统一退役（规格 §5.5）与补充时间窗入口退役（§5.7）。
--
-- 纯 JSON 键退役：不改任何表/列 DDL（历史 DDL immutable），不删 media_supplement_window_minutes
-- 旧 INTEGER 列（列留在原地，从此无运行时映射）。qq_schemes.media_input 列自 0052 起被列级
-- CHECK 限定为 NULL 或合法 JSON object；qq_group_agent_configs.scheme_overrides 同样是 object。
-- 普通静图旧值（ordinary_still_max_dimension）是 canonical，原样保留；动图 canonical 是 rhythm
-- 的 media_frame_count / media_max_dimension 列（0029），同样一行都不重写。
--
-- json_remove 只删批准退役的键，不存在的键原样返回；其余字段的值保持不变（JSON 文本格式可能
-- 变化，值不变，不做字节承诺）。WHERE 用 CASE 先验 json_valid 再验 json_type：历史坏行
-- （绕过 CHECK 写入的非合法 JSON）让 json_type 抛错会中止整个迁移；这里显式跳过它们，
-- 非法载体原样保留、不静默改形。只处理"载体内真的存在退役键"的行：合法但根不是 object、
-- 以及不含退役键的对象都不改形，维持 fail-closed 与"未改字段原值不动"。
UPDATE qq_schemes SET media_input = json_remove(media_input,
    '$."expression_max_dimension"',
    '$."expression_frame_count"',
    '$."expression_frame_max_dimension"'
  )
WHERE CASE
    WHEN json_valid(media_input) THEN json_type(media_input) = 'object'
    ELSE 0
  END
  AND (
    CASE
      WHEN json_valid(media_input) THEN
        json_type(media_input, '$."expression_max_dimension"') IS NOT NULL
        OR json_type(media_input, '$."expression_frame_count"') IS NOT NULL
        OR json_type(media_input, '$."expression_frame_max_dimension"') IS NOT NULL
      ELSE 0
    END
  );

-- 群稀疏覆盖：media_input 覆盖是 object 时删同样三个表情规格键；rhythm 覆盖是 object 时删
-- media_supplement_window_minutes。两者各自独立；任一载体不是 object 时对应路径是空操作，
-- 兄弟键（triggers/task_limits/stages 等）与兄弟值一律不动。
UPDATE qq_group_agent_configs SET scheme_overrides = json_remove(scheme_overrides,
    '$."media_input"."expression_max_dimension"',
    '$."media_input"."expression_frame_count"',
    '$."media_input"."expression_frame_max_dimension"',
    '$."rhythm"."media_supplement_window_minutes"'
  )
WHERE CASE
    WHEN json_valid(scheme_overrides) THEN json_type(scheme_overrides) = 'object'
    ELSE 0
  END
  AND (
    CASE
      WHEN json_valid(scheme_overrides) THEN
        json_type(scheme_overrides, '$."media_input"."expression_max_dimension"') IS NOT NULL
        OR json_type(scheme_overrides, '$."media_input"."expression_frame_count"') IS NOT NULL
        OR json_type(scheme_overrides, '$."media_input"."expression_frame_max_dimension"') IS NOT NULL
        OR json_type(scheme_overrides, '$."rhythm"."media_supplement_window_minutes"') IS NOT NULL
      ELSE 0
    END
  );
