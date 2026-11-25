import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, GripVertical, Plus, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { UserRule } from "@subscription-converter/shared";

import { ErrorBanner } from "../components/ErrorBanner";
import { RuleModal, type RuleDraftInput } from "../components/RuleModal";
import { PageHeader } from "../components/PageHeader";
import { RuleAssistant } from "../components/RuleAssistant";
import { SortableRuleRow } from "../components/SortableRuleRow";
import { apiRequest } from "../lib/api";
import type { ManagedOutputProfile } from "../types/output";

const defaultPolicies = ["PROXY", "AUTO", "DIRECT", "REJECT"];

export function RulesPage({
  profileId,
  profileName,
  onBack,
}: { profileId?: string; profileName?: string; onBack?: () => void } = {}) {
  const rulesKey = profileId ? ["output", "rules", profileId] : ["rules"];
  const rulesUrl = profileId
    ? `/api/output/profiles/${profileId}/rules`
    : "/api/rules";
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editingRule, setEditingRule] = useState<UserRule>();
  const [draftRules, setDraftRules] = useState<UserRule[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [draggedRuleId, setDraggedRuleId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const rules = useQuery({
    queryKey: rulesKey,
    queryFn: () => apiRequest<UserRule[]>(rulesUrl),
  });
  const profiles = useQuery({
    queryKey: ["output", "profiles"],
    queryFn: () => apiRequest<ManagedOutputProfile[]>("/api/output/profiles"),
  });
  const saveRules = useMutation({
    mutationFn: (rulesToSave: UserRule[]) =>
      apiRequest<UserRule[]>(rulesUrl, {
        method: "PUT",
        body: JSON.stringify({
          rules: rulesToSave.map((rule) => ({
            id: rule.id.startsWith("draft-") ? undefined : rule.id,
            ruleType: rule.ruleType,
            noResolve: rule.noResolve ?? false,
            value: rule.value,
            policy: rule.policy,
            enabled: rule.enabled,
            note: rule.note,
          })),
        }),
      }),
    onSuccess: (savedRules) => {
      setDraftRules(savedRules);
      setIsDirty(false);
      setDraggedRuleId(null);
      queryClient.setQueryData(rulesKey, savedRules);
      if (profileId)
        void queryClient.invalidateQueries({
          queryKey: ["output", "profiles"],
        });
      void queryClient.invalidateQueries({ queryKey: ["output", "preview"] });
      void queryClient.invalidateQueries({
        queryKey: ["output", "availability"],
      });
    },
  });

  useEffect(() => {
    if (rules.data && !isDirty) {
      setDraftRules(rules.data);
    }
  }, [isDirty, rules.data]);

  const visibleRules = draftRules;
  const clashProfile = profiles.data?.find((profile) =>
    profileId ? profile.id === profileId : profile.id === "default-clash",
  );
  const applicableProfiles = profileId
    ? clashProfile
      ? [clashProfile]
      : []
    : (profiles.data?.filter((profile) => profile.targetClient === "clash") ??
      []);
  const customPolicies = [
    ...new Set(
      applicableProfiles.flatMap((profile) =>
        profile.options.proxyGroups.map((group) => group.name),
      ),
    ),
  ];
  const ruleProviders = [
    ...new Set(
      applicableProfiles.flatMap((profile) =>
        Object.keys(profile.options.ruleProviders),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const policies = [...new Set([...defaultPolicies, ...customPolicies])];
  const operationError = saveRules.error;

  const replaceDraftRules = (nextRules: UserRule[]) => {
    setDraftRules(normalizeSortOrder(nextRules));
    setIsDirty(true);
    saveRules.reset();
  };

  const upsertDraftRule = (input: RuleDraftInput, rule?: UserRule) => {
    const now = new Date().toISOString();
    if (rule) {
      replaceDraftRules(
        visibleRules.map((item) =>
          item.id === rule.id ? { ...item, ...input, updatedAt: now } : item,
        ),
      );
      setEditingRule(undefined);
      return;
    }

    replaceDraftRules([
      ...visibleRules,
      {
        id: createDraftRuleId(),
        ...input,
        enabled: true,
        sortOrder: visibleRules.length,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    setShowCreate(false);
  };

  const toggleDraftRule = (rule: UserRule) => {
    replaceDraftRules(
      visibleRules.map((item) =>
        item.id === rule.id
          ? {
              ...item,
              enabled: !item.enabled,
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    );
  };

  const deleteDraftRule = (rule: UserRule) => {
    if (!window.confirm("确定删除这条规则吗？")) return;
    replaceDraftRules(visibleRules.filter((item) => item.id !== rule.id));
  };

  const resetDraft = () => {
    setDraftRules(rules.data ?? []);
    setIsDirty(false);
    setDraggedRuleId(null);
    saveRules.reset();
  };

  const saveDraft = () => {
    saveRules.mutate(normalizeSortOrder(visibleRules));
  };

  const activeRule = visibleRules.find((rule) => rule.id === draggedRuleId);
  const finishDrag = ({ active, over }: DragEndEvent) => {
    setDraggedRuleId(null);
    if (!over || active.id === over.id) return;
    const from = visibleRules.findIndex((rule) => rule.id === active.id);
    const to = visibleRules.findIndex((rule) => rule.id === over.id);
    if (from >= 0 && to >= 0)
      replaceDraftRules(arrayMove(visibleRules, from, to));
  };

  return (
    <div className="page">
      <PageHeader
        title={profileName ? `${profileName}的规则` : "规则编辑"}
        description={
          profileName
            ? "只影响当前输出，保存后生效。"
            : "全局规则供选择“使用全局规则”的输出共用。"
        }
        actions={
          <>
            {onBack && (
              <button
                className="secondary-button"
                onClick={() => {
                  if (
                    !isDirty ||
                    window.confirm("独立规则尚未保存，确定返回吗？")
                  )
                    onBack();
                }}
              >
                返回输出
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={!isDirty || saveRules.isPending}
              onClick={resetDraft}
            >
              放弃更改
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!isDirty || saveRules.isPending || rules.isPending}
              onClick={saveDraft}
            >
              {saveRules.isPending ? "正在保存..." : "保存规则"}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => setShowCreate(true)}
            >
              <Plus size={17} />
              新增规则
            </button>
          </>
        }
      />
      <div className="info-banner">
        <ShieldAlert size={19} />
        <div>
          <strong>MATCH 是最终兜底</strong>
          <span>
            只能启用一条 MATCH，并且必须排在所有启用规则之后；保存时会统一校验。
          </span>
        </div>
      </div>
      <ErrorBanner error={rules.error ?? profiles.error ?? operationError} />
      <section className="panel table-panel">
        <div className="table-toolbar">
          <div>
            <strong>{visibleRules.length} 条规则</strong>
            <span>
              {isDirty
                ? "有未保存更改，点击“保存规则”后才会生效"
                : customPolicies.length > 0
                  ? `可分流到 ${customPolicies.join("、")}`
                  : "输出时自动忽略已禁用项目"}
            </span>
          </div>
        </div>
        {rules.isPending ? (
          <div className="list-empty">正在读取规则...</div>
        ) : visibleRules.length ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            autoScroll={{ threshold: { x: 0, y: 0.18 }, acceleration: 12 }}
            onDragStart={({ active }) => setDraggedRuleId(String(active.id))}
            onDragEnd={finishDrag}
            onDragCancel={() => setDraggedRuleId(null)}
            accessibility={{
              screenReaderInstructions: {
                draggable: "用鼠标或触屏拖动排序，键盘直接按上下方向键移动。",
              },
            }}
          >
            <SortableContext
              items={visibleRules.map((rule) => rule.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="rules-list">
                {visibleRules.map((rule, index) => (
                  <SortableRuleRow
                    key={rule.id}
                    rule={rule}
                    index={index}
                    disabled={saveRules.isPending}
                    onEdit={() => setEditingRule(rule)}
                    onToggle={() => toggleDraftRule(rule)}
                    onDelete={() => deleteDraftRule(rule)}
                    onMove={(offset) => {
                      const to = index + offset;
                      if (
                        !draggedRuleId &&
                        to >= 0 &&
                        to < visibleRules.length
                      ) {
                        replaceDraftRules(arrayMove(visibleRules, index, to));
                      }
                    }}
                  />
                ))}
              </div>
            </SortableContext>
            {createPortal(
              <DragOverlay
                dropAnimation={
                  window.matchMedia("(prefers-reduced-motion: reduce)").matches
                    ? null
                    : { duration: 190, easing: "cubic-bezier(.2,.75,.25,1)" }
                }
              >
                {activeRule && (
                  <div className="rule-drag-preview" aria-hidden="true">
                    <GripVertical size={18} />
                    <span className="rule-type">{activeRule.ruleType}</span>
                    <strong>{activeRule.value ?? "所有剩余流量"}</strong>
                    <span className="policy-chip">{activeRule.policy}</span>
                  </div>
                )}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
        ) : (
          <div className="list-empty">
            <span className="empty-illustration">
              <Braces size={25} />
            </span>
            <strong>还没有自定义规则</strong>
            <p>添加域名、CIDR、GEOIP 或 MATCH 规则来控制最终输出。</p>
          </div>
        )}
      </section>
      {showCreate && (
        <RuleModal
          policies={policies}
          ruleProviders={ruleProviders}
          onClose={() => setShowCreate(false)}
          onSave={(input) => upsertDraftRule(input)}
        />
      )}
      {editingRule && (
        <RuleModal
          policies={policies}
          ruleProviders={ruleProviders}
          rule={editingRule}
          onClose={() => setEditingRule(undefined)}
          onSave={(input) => upsertDraftRule(input, editingRule)}
        />
      )}
      <RuleAssistant
        rules={visibleRules}
        policies={policies}
        ruleProviders={ruleProviders}
        scope={
          profileId
            ? `独立规则草稿：${profileName ?? profileId}`
            : "全局规则草稿"
        }
        busy={rules.isPending || saveRules.isPending || draggedRuleId !== null}
        onApply={replaceDraftRules}
      />
    </div>
  );
}

function normalizeSortOrder(rules: UserRule[]) {
  return rules.map((rule, sortOrder) => ({ ...rule, sortOrder }));
}

function createDraftRuleId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `draft-${crypto.randomUUID()}`;
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
