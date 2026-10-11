-- QQ 表情发送倾向：三档软倾向，独立于素材重复间隔与避旧两条既有规则；
-- 仅当方案的选图提示词仍逐字等于原出厂默认时替换为新出厂默认，自定义原文一律保留。
ALTER TABLE qq_schemes ADD COLUMN sticker_frequency TEXT NOT NULL DEFAULT 'medium' CHECK (sticker_frequency IN ('low', 'medium', 'high'));

UPDATE qq_schemes
SET prompt_sticker = '按当前语境自主选择文字、表情或两者组合；没有合适内容时可以不回复。
需要表情时，先用 sticker.search 查看候选，再用 reply.sticker 选择本次已披露的素材 ID；每个目标至多一张。只发文字时使用 reply.text，不必另行声明不用表情。
不要为了装饰勉强加图，不选无关或刚发过的素材。'
WHERE prompt_sticker = '你只做一件事：从给定候选里挑一张最贴合当前语境的图。
只输出候选编号；没有贴合的就不选，不要勉强凑一张。
不选与话题无关的图，也不选刚发过的那张。';
