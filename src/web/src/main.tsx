import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth";
import "./index.css";
import { Book } from "./pages/Book";
import { Home } from "./pages/Home";
import { NotFound } from "./pages/NotFound";
import { ForgotPassword, Login, NewPassword } from "./pages/Login";
import { PatientAppointment } from "./pages/PatientAppointment";
import { Loading, ToastProvider } from "./ui";

// The public pages are small and come with the first script, so a patient's page needs no second request
// before it can draw. The clinic's side is the large part: it is one separate piece (staff.tsx), fetched
// only when someone opens /app. A patient booking an appointment never downloads it.
const staff = () => import("./staff");
const AppLayout = lazy(() => staff().then((m) => ({ default: m.AppLayout })));
const Calendar = lazy(() => staff().then((m) => ({ default: m.Calendar })));
const Appointments = lazy(() => staff().then((m) => ({ default: m.Appointments })));
const Reports = lazy(() => staff().then((m) => ({ default: m.Reports })));
const Patients = lazy(() => staff().then((m) => ({ default: m.Patients })));
const PatientDetail = lazy(() => staff().then((m) => ({ default: m.PatientDetail })));
const Due = lazy(() => staff().then((m) => ({ default: m.Due })));
const Outbox = lazy(() => staff().then((m) => ({ default: m.Outbox })));
const Settings = lazy(() => staff().then((m) => ({ default: m.Settings })));
const Reviews = lazy(() => staff().then((m) => ({ default: m.Reviews })));
const Gallery = lazy(() => staff().then((m) => ({ default: m.Gallery })));

/** The pages that need to know who is logged in. The patient's pages are outside it and never ask. */
function WithSession() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={<Loading />}>
          <Routes>
            {/* The patient's pages: no account, no session. */}
            <Route path="/" element={<Home />} />
            <Route path="/rezervo" element={<Book />} />
            <Route path="/termin" element={<PatientAppointment />} />

            <Route element={<WithSession />}>
              <Route path="/kycu" element={<Login />} />
              <Route path="/harrova-fjalekalimin" element={<ForgotPassword />} />
              <Route path="/fjalekalimi" element={<NewPassword />} />

              {/* The clinic's side. AppLayout sends anyone without a session to the login page. */}
              <Route path="/app" element={<AppLayout />}>
                <Route index element={<Navigate to="kalendari" replace />} />
                <Route path="kalendari" element={<Calendar />} />
                <Route path="terminet" element={<Appointments />} />
                <Route path="raportet" element={<Reports />} />
                <Route path="pacientet" element={<Patients />} />
                <Route path="pacientet/:id" element={<PatientDetail />} />
                <Route path="kontrolle" element={<Due />} />
                <Route path="emailat" element={<Outbox />} />
                <Route path="vleresimet" element={<Reviews />} />
                <Route path="galeria" element={<Gallery />} />
                <Route path="cilesimet" element={<Settings />} />
              </Route>
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
