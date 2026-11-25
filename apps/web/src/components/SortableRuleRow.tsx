import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { UserRule } from "@subscription-converter/shared";
import { GripVertical, Pencil, Trash2 } from "lucide-react";

export function SortableRuleRow({
  rule,
  index,
  disabled,
  onEdit,
  onToggle,
  onDelete,
  onMove,
}: {
  rule: UserRule;
  index: number;
  disabled: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onMove: (offset: -1 | 1) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: rule.id,
    disabled,
    transition: { duration: 190, easing: "cubic-bezier(.2,.75,.25,1)" },
  });
  const label = `${rule.ruleType} ${rule.value ?? rule.policy}`;
  return (
    <article
      ref={setNodeRef}
      className={`rule-row${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="rule-order">
        <button
          ref={setActivatorNodeRef}
          className="rule-drag-handle"
          type="button"
          disabled={disabled}
          {...attributes}
          {...listeners}
          aria-label={`拖动 ${label}`}
          title="拖动排序，或用上下方向键移动"
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const handle = event.currentTarget;
            onMove(event.key === "ArrowUp" ? -1 : 1);
            requestAnimationFrame(() => {
              if (!handle.isConnected) return;
              if (document.activeElement === document.body) {
                handle.focus({ preventScroll: true });
              }
              if (document.activeElement === handle) {
                handle.scrollIntoView({ block: "nearest" });
              }
            });
          }}
        >
          <GripVertical size={15} aria-hidden="true" />
        </button>
        <span>{String(index + 1).padStart(2, "0")}</span>
      </div>
      <span className="rule-type">{rule.ruleType}</span>
      <div className="rule-value">
        <strong>{rule.value ?? "所有剩余流量"}</strong>
        <small>
          {rule.noResolve ? "不触发 DNS 解析 · " : ""}
          {rule.note || "无备注"}
        </small>
      </div>
      <span className={`policy-chip ${rule.policy.toLowerCase()}`}>
        {rule.policy}
      </span>
      <div className="row-actions">
        <button
          type="button"
          className="icon-action"
          aria-label={`编辑 ${label}`}
          onClick={onEdit}
        >
          <Pencil size={15} />
        </button>
        <button
          type="button"
          className={`toggle ${rule.enabled ? "on" : ""}`}
          aria-label={`${rule.enabled ? "禁用" : "启用"} ${label}`}
          onClick={onToggle}
        >
          <span />
        </button>
        <button
          type="button"
          className="icon-action danger"
          aria-label={`删除 ${label}`}
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}
