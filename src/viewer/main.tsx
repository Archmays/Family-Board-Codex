import { createRoot } from "react-dom/client";
import "../shared/styles.css";
import "./viewer.css";
import ViewerApp from "./ViewerApp";

const root = document.getElementById("root");

if (!root) throw new Error("Missing application root");

createRoot(root).render(<ViewerApp />);
