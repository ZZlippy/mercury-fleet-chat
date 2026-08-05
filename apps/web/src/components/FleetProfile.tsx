import { useEffect, useState } from "react";
import { api, type FleetProfileView } from "../api";

interface Draft {
  fleetName: string;
  acceptingOrders: boolean;
  operatingCountries: string;
  supportsHazardous: boolean;
  supportsReefer: boolean;
  contactName: string;
  contactPhone: string;
  notes: string;
}

const emptyDraft = (organizationName: string): Draft => ({
  fleetName: organizationName,
  acceptingOrders: true,
  operatingCountries: "SG",
  supportsHazardous: false,
  supportsReefer: false,
  contactName: "",
  contactPhone: "",
  notes: "",
});

export function FleetProfilePanel({
  organizationName,
  onBack,
}: {
  organizationName: string;
  onBack: () => void;
}) {
  const [profile, setProfile] = useState<FleetProfileView | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(organizationName));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = async () => {
    const response = await api.fleetProfile();
    const next = response.profile;
    setProfile(next);
    const source = next?.pending ?? next?.approved;
    if (source) {
      setDraft({
        fleetName: source.fleet_name ?? organizationName,
        acceptingOrders: Boolean(next?.accepting_orders),
        operatingCountries: (source.operating_countries ?? []).join(", "),
        supportsHazardous: Boolean(source.supports_hazardous),
        supportsReefer: Boolean(source.supports_reefer),
        contactName: source.contact_name ?? "",
        contactPhone: source.contact_phone ?? "",
        notes: source.notes ?? "",
      });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const toggleAccepting = async (acceptingOrders: boolean) => {
    set("acceptingOrders", acceptingOrders);
    try {
      await api.setAcceptingOrders(acceptingOrders);
      setProfile((current) => current ? { ...current, accepting_orders: acceptingOrders } : current);
      setNotice(acceptingOrders ? "已恢复接单。" : "已立即暂停接单。");
    } catch (error: any) {
      setNotice(error.message ?? "接单状态更新失败。");
    }
  };

  const submit = async () => {
    setBusy(true);
    setNotice("");
    try {
      await api.submitFleetProfile({
        fleetName: draft.fleetName,
        acceptingOrders: draft.acceptingOrders,
        operatingCountries: draft.operatingCountries
          .split(/[,，\s]+/)
          .map((country) => country.trim().toUpperCase())
          .filter(Boolean),
        supportsHazardous: draft.supportsHazardous,
        supportsReefer: draft.supportsReefer,
        contactName: draft.contactName,
        contactPhone: draft.contactPhone,
        notes: draft.notes || null,
      });
      setNotice("档案已提交，等待 Mercury 运营审核。审核期间继续使用上一份已通过档案。");
      await load();
    } catch (error: any) {
      setNotice(error.body?.error?.formErrors?.join("；") ?? error.message ?? "提交失败。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="conversation-pane profile-pane">
      <header className="conversation-header">
        <button className="text-button" type="button" onClick={onBack}>← 返回任务</button>
        <div className="conversation-heading">
          <h1>车队档案</h1>
          <p>能力信息修改后需由 Mercury 运营审核；接单开关立即生效。</p>
        </div>
      </header>
      <div className="profile-editor">
        {notice ? <div className="inline-notice">{notice}</div> : null}
        <div className="profile-status-card">
          <strong>账号状态</strong>
          <label className="check-label">
            <input
              type="checkbox"
              checked={draft.acceptingOrders}
              onChange={(event) => void toggleAccepting(event.target.checked)}
            />
            {draft.acceptingOrders ? "正在接单" : "暂停接单"}
          </label>
          <span>
            {profile?.pending
              ? "档案状态：待审核"
              : profile?.approved
                ? "档案状态：已通过"
                : profile?.latest_rejected
                  ? `档案状态：已退回（${profile.latest_rejected.review_note ?? "请修改后重交"}）`
                  : "档案状态：未填写"}
          </span>
        </div>
        <div className="form-grid">
          <label>车队名称*<input value={draft.fleetName} onChange={(e) => set("fleetName", e.target.value)} /></label>
          <label>营运国家*<input placeholder="SG, MY, CN" value={draft.operatingCountries} onChange={(e) => set("operatingCountries", e.target.value)} /></label>
          <label>联系人*<input value={draft.contactName} onChange={(e) => set("contactName", e.target.value)} /></label>
          <label>联系电话*<input value={draft.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} /></label>
          <label className="check-label"><input type="checkbox" checked={draft.supportsHazardous} onChange={(e) => set("supportsHazardous", e.target.checked)} />具备危险品运输能力</label>
          <label className="check-label"><input type="checkbox" checked={draft.supportsReefer} onChange={(e) => set("supportsReefer", e.target.checked)} />具备冷藏箱运输能力</label>
          <label className="wide">备注<textarea rows={4} value={draft.notes} onChange={(e) => set("notes", e.target.value)} /></label>
        </div>
        <button className="button button-primary" type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? "提交中…" : "提交审核"}
        </button>
      </div>
    </section>
  );
}
