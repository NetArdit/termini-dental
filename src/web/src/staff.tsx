// The clinic's side of the application, as one piece of code. It is fetched the first time someone opens
// /app, in a single request: splitting it page by page would make every first visit wait for one more
// round trip per page, to save a few kilobytes each.
export { AppLayout } from "./pages/AppLayout";
export { Calendar } from "./pages/Calendar";
export { Due } from "./pages/Due";
export { Outbox } from "./pages/Outbox";
export { PatientDetail, Patients } from "./pages/Patients";
export { Reports } from "./pages/Reports";
export { Settings } from "./pages/Settings";
