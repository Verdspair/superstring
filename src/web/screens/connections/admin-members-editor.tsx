import { Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { normalizeOneBotAccountId } from "../../../shared/contracts/onebot-identity";
import { QQ_ATTENTION_MEMBER_LIMIT } from "../../../shared/contracts/qq";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { parseAdminMembers } from "../../features/qq/draft-state";

export interface AdminMembersEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** 管理员名单受控呈现与单项移除组件，复用 draft-state 规范解析与 32px 触区。 */
export function AdminMembersEditor({ value, onChange, disabled = false }: AdminMembersEditorProps) {
  const { t } = useTranslation();

  const parsed = useMemo(() => parseAdminMembers(value), [value]);

  const handleRemoveCanonical = (canonicalMember: string) => {
    const next = parsed.rawItems
      .filter((token) => normalizeOneBotAccountId(token) !== canonicalMember)
      .join(" ");
    onChange(next);
  };

  const handleRemoveInvalidToken = (tokenToRemove: string) => {
    const next = parsed.rawItems.filter((token) => token !== tokenToRemove).join(" ");
    onChange(next);
  };

  const handleClear = () => {
    onChange("");
  };

  const hasAnyBadge = parsed.validCanonicalMembers.length > 0 || parsed.invalidTokens.length > 0;

  return (
    <div className="space-y-2">
      {hasAnyBadge && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2.5"
          data-testid="admin-badges-container"
        >
          {parsed.validCanonicalMembers.map((member) => (
            <Badge
              key={member}
              variant="secondary"
              className="h-auto py-1 pl-2.5 pr-1 text-xs gap-1.5"
              data-testid={`admin-badge-${member}`}
            >
              <span className="font-mono">{member}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="min-h-8 min-w-8 p-0 rounded-full hover:bg-muted"
                disabled={disabled}
                aria-label={t("connections.deleteMember", { "0": member })}
                onClick={() => handleRemoveCanonical(member)}
              >
                <X className="size-3.5" />
              </Button>
            </Badge>
          ))}

          {Array.from(new Set(parsed.invalidTokens)).map((token) => (
            <Badge
              key={`invalid-${token}`}
              variant="destructive"
              className="h-auto py-1 pl-2.5 pr-1 text-xs gap-1.5"
              data-testid={`admin-badge-${token}`}
            >
              <span className="font-mono">{token}</span>
              <span className="text-[10px] opacity-80">({t("connections.invalidFormat")})</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="min-h-8 min-w-8 p-0 rounded-full hover:bg-muted"
                disabled={disabled}
                aria-label={t("connections.deleteMember", { "0": token })}
                onClick={() => handleRemoveInvalidToken(token)}
              >
                <X className="size-3.5" />
              </Button>
            </Badge>
          ))}

          {!disabled &&
            (parsed.validCanonicalMembers.length > 1 || parsed.invalidTokens.length > 0) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto min-h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleClear}
              >
                <Trash2 className="size-3.5 mr-1" />
                {t("connections.clearAll")}
              </Button>
            )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="space-x-2 text-muted-foreground">
          <span>
            {parsed.canonicalCount === 0 && !parsed.hasInvalid ? (
              <span>{t("connections.noAdminsConfigured")}</span>
            ) : (
              <span>
                {t("connections.attentionList")}:{" "}
                <span className="font-mono font-medium">{parsed.canonicalCount}</span> /{" "}
                {QQ_ATTENTION_MEMBER_LIMIT}
              </span>
            )}
          </span>
          {parsed.hasDuplicates && (
            <span className="text-muted-foreground">
              · {t("connections.duplicateMembersAutoMerge")}
            </span>
          )}
        </div>

        {parsed.hasInvalid && (
          <p role="alert" className="text-destructive font-medium">
            {t("connections.hasInvalidMembers")}
          </p>
        )}

        {parsed.isOverLimit && (
          <p role="alert" className="text-destructive font-medium">
            {t("connections.overMemberLimit")}
          </p>
        )}
      </div>
    </div>
  );
}
