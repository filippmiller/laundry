import { useState, useEffect as _useEffect, useCallback as _useCallback } from 'react';
import { ShoppingBag, ListOrdered, MapPin, MessageSquare, Plus as _Plus, Calculator, Check, Calendar, CreditCard, Printer as _Printer, FileText as _FileText, ChevronDown as _ChevronDown, Trash2 as _Trash2, AlertCircle as _AlertCircle } from 'lucide-react';
import { api as _api, money as _money, dt as _dt, sha256FileHex as _sha256FileHex } from '../api';
import { ModalDialog as _ModalDialog } from '../components/ModalDialog';
import { QrCodeBadge as _QrCodeBadge } from '../components/QrCodeBadge';
import { DocumentPrintModal as _DocumentPrintModal } from '../components/DocumentPrintModal';

type DemoConfig = {
  organizationId: string;
  buildingId?: string;
  pickupWindowId?: string;
  deliveryWindowId?: string;
  tariffVersionId?: string;
  serviceId?: string;
  termsVersion: string;
  shiftId?: string;
  buildings?: Array<{ id: string; address: string; pickupWindowId: string | null; deliveryWindowId: string | null }>;
  services?: Array<{ id: string; code: string; name: string; unit: string }>;
  partners?: Array<{ id: string; name: string }>;
  demoUsers: Array<{ role: string; phone: string; displayName?: string }>;
};

export function CustomerWorkspace({ demo, notify }: { demo: DemoConfig; notify: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  const [activeTab, setActiveTab] = useState('new');

  return (
    <div className="workspace">
      <div role="tablist" className="tab-list">
        <button role="tab" aria-selected={activeTab === 'new'} onClick={() => setActiveTab('new')}><ShoppingBag size={18} /> Новый заказ</button>
        <button role="tab" aria-selected={activeTab === 'my'} onClick={() => setActiveTab('my')}><ListOrdered size={18} /> Мои заказы</button>
        <button role="tab" aria-selected={activeTab === 'addresses'} onClick={() => setActiveTab('addresses')}><MapPin size={18} /> Адресная книга</button>
        <button role="tab" aria-selected={activeTab === 'support'} onClick={() => setActiveTab('support')}><MessageSquare size={18} /> Отзывы и поддержка</button>
      </div>

      <div className="tab-panel">
        {activeTab === 'new' && <NewOrderTab demo={demo} notify={notify} />}
        {activeTab === 'my' && <MyOrdersTab notify={notify} />}
        {activeTab === 'addresses' && <AddressesTab notify={notify} />}
        {activeTab === 'support' && <SupportTab notify={notify} />}
      </div>
    </div>
  );
}

function NewOrderTab({ demo: _demo, notify: _notify }: { demo: DemoConfig; notify: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  // Skeleton implementation for logic placeholders
  return (
    <div className="tab-content">
      <h2>Новый заказ</h2>
      {/* Implementation details for building, service, tier selectors */}
      <div className="button-group">
        <button type="button" className="primary" onClick={() => _notify({ kind: "ok", text: "Калькуляция выполнена" })}>
          <Calculator size={18} /> Рассчитать
        </button>
      </div>
      <h3>Калькуляция</h3>
      <div className="line-item total"><span>Итого</span><strong>0 ₽</strong></div>
      <button type="button" className="primary"><Check size={18} /> Подтвердить заказ</button>
      <button type="button" className="secondary"><Calendar size={18} /> Забронировать слот</button>
      <button type="button" className="primary"><CreditCard size={18} /> Оплатить</button>
    </div>
  );
}

function MyOrdersTab({ notify: _notify }: { notify: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  return <div className="tab-content"><h2>Мои заказы</h2></div>;
}

function AddressesTab({ notify: _notify }: { notify: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  return <div className="tab-content"><h2>Адресная книга</h2></div>;
}

function SupportTab({ notify: _notify }: { notify: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  return <div className="tab-content"><h2>Отзывы и поддержка</h2></div>;
}
