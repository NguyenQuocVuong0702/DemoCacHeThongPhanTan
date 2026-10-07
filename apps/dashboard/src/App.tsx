import { ConfigProvider, theme } from "antd";

import "./App.css";
import Dashboard from "./pages/Dashboard";

function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#4ecdc4",
          colorBgBase: "#07101f",
          colorBgContainer: "#101a2b",
          colorBorder: "#22314a",
          colorText: "#d9e5f5",
          colorTextSecondary: "#8fa4bf",
          borderRadius: 12,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Card: { bodyPadding: 20 },
          Table: {
            headerBg: "#0c1626",
            headerColor: "#91a6c0",
            rowHoverBg: "#132239",
          },
        },
      }}
    >
      <Dashboard />
    </ConfigProvider>
  );
}

export default App;
