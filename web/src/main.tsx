import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { FamilyClaim, FamilyLogin } from './family';
import { I18nProvider, LangRoot, LangSwitch, useI18n } from './i18n';
import { loadConfig } from './lib';
import { ClaimDetail, ClaimList, NewClaim, Requests, StaffLogin, StaffShell } from './staff';
import './styles.css';

function Landing() {
  const { t } = useI18n();
  return (
    <LangRoot>
      <main className="narrow">
        <div className="topbar"><LangSwitch /></div>
        <h1>{t('appTitle')}</h1>
        <p className="lead">{t('landingLead')}</p>
        <div className="stack">
          <Link className="card choice" to="/family"><strong>{t('imFamily')}</strong><span className="muted">{t('imFamilyHint')}</span></Link>
          <Link className="card choice" to="/staff"><strong>{t('imStaff')}</strong><span className="muted">{t('imStaffHint')}</span></Link>
        </div>
      </main>
    </LangRoot>
  );
}

void loadConfig().then(() =>
  createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/family" element={<FamilyLogin />} />
        <Route path="/family/claim" element={<FamilyClaim />} />
        <Route path="/staff/login" element={<StaffLogin />} />
        <Route path="/staff" element={<StaffShell />}>
          <Route index element={<ClaimList />} />
          <Route path="new" element={<NewClaim />} />
          <Route path="requests" element={<Requests />} />
          <Route path="claims/:claimId" element={<ClaimDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
  ),
);


