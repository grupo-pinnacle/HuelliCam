import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { User } from "../types";

const mockAuthState: { user: User | null } = {
  user: null,
};

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPatch = vi.fn();

const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: mockAuthState.user,
    loading: false,
    sessionTerminated: null,
    dismissSessionTerminated: vi.fn(),
    clearSession: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refreshSession: vi.fn(),
  }),
}));

vi.mock("../services/api", () => ({
  default: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
  },
  getAccessToken: () => "mock-token",
  getDeviceId: () => "mock-device",
}));

vi.mock("socket.io-client", () => ({
  io: () => mockSocket,
}));

vi.mock("@livekit/components-react", () => ({
  LiveKitRoom: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-livekit-room">{children}</div>
  ),
  VideoConference: () => <div data-testid="mock-video-conference" />,
  useLocalParticipant: () => ({
    isMicrophoneEnabled: true,
    isCameraEnabled: true,
    localParticipant: {
      setMicrophoneEnabled: vi.fn(),
      setCameraEnabled: vi.fn(),
    },
  }),
}));

vi.mock("@livekit/components-styles", () => ({}));

import CallRoom from "../vet/CallRoom";

function makeUser(role: "CLIENT" | "VET"): User {
  return {
    id: role === "CLIENT" ? "tutor-1" : "vet-user-1",
    email: role === "CLIENT" ? "tutor@example.com" : "vet@example.com",
    firstName: role === "CLIENT" ? "Lucía" : "Martín",
    lastName: role === "CLIENT" ? "Gómez" : "Rojas",
    role,
    ratingAvg: 5,
    ratingCount: 10,
    isOnline: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderCallRoom() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/call/consult-1"]}>
        <CallRoom id="consult-1" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CallRoom clinical chat and waiting room parity", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockApiPost.mockResolvedValue({ data: { success: false } });
    mockApiPatch.mockReset();
    mockApiPatch.mockResolvedValue({ data: { success: true } });
    mockSocket.on.mockReset();
    mockSocket.off.mockReset();
    mockSocket.emit.mockReset();
    mockSocket.disconnect.mockReset();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline test LiveKit skip"))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("preserves WaitingRoomExperience when consultation is WAITING for tutor", async () => {
    mockAuthState.user = makeUser("CLIENT");
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/api/consultations/consult-1") {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              id: "consult-1",
              clientId: "tutor-1",
              petId: "milo",
              status: "WAITING",
              reason: "Control dermatológico",
              pet: {
                id: "milo",
                name: "Milo",
                species: "DOG",
                breed: "Caniche",
              },
              client: {
                id: "tutor-1",
                firstName: "Lucía",
                lastName: "Gómez",
              },
            },
          },
        });
      }
      return Promise.resolve({ data: { success: true, data: [] } });
    });

    renderCallRoom();

    await waitFor(() => {
      expect(screen.getByTestId("waiting-room-experience")).toBeInTheDocument();
    });
  });

  it("renders unified sidebar clinical chat UI inside active CallRoom for CLIENT without quick replies", async () => {
    mockAuthState.user = makeUser("CLIENT");
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/api/consultations/consult-1") {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              id: "consult-1",
              clientId: "tutor-1",
              vetId: "vet-user-1",
              petId: "milo",
              status: "ACTIVE",
              reason: "Control dermatológico",
              pet: {
                id: "milo",
                name: "Milo",
                species: "DOG",
                breed: "Caniche",
              },
              client: {
                id: "tutor-1",
                firstName: "Lucía",
                lastName: "Gómez",
              },
              vet: {
                id: "vet-user-1",
                firstName: "Martín",
                lastName: "Rojas",
              },
            },
          },
        });
      }
      if (url === "/api/consultations/consult-1/messages") {
        return Promise.resolve({ data: { success: true, data: [] } });
      }
      return Promise.resolve({ data: { success: true, data: [] } });
    });

    const { container } = renderCallRoom();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Chat$/i })).toBeInTheDocument();
    });

    const panel = container.querySelector("aside.v-call__panel");
    expect(panel).toHaveClass("is-closed");

    fireEvent.click(screen.getByRole("button", { name: /^Chat$/i }));

    expect(panel).toHaveClass("is-open");
    expect(container.querySelector(".wa-chat-pane__header")).toBeInTheDocument();
    expect(screen.getByTestId("clinical-security-note")).toBeInTheDocument();
    expect(screen.getByTestId("empty-conversation-notice")).toBeInTheDocument();
    expect(screen.getByTestId("chat-message-input")).toBeInTheDocument();
    expect(screen.getByTestId("chat-send-btn")).toBeInTheDocument();

    const attachBtn = screen.getByRole("button", { name: "Adjuntar" });
    fireEvent.click(attachBtn);
    expect(screen.getByTestId("attach-pdf-btn")).toBeInTheDocument();
    expect(screen.getByTestId("attach-img-btn")).toBeInTheDocument();
    expect(screen.getByTestId("attach-prescription-btn")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Respuestas rápidas" })).not.toBeInTheDocument();
  });

  it("renders unified clinical chat UI plus quick replies for VET in active CallRoom", async () => {
    mockAuthState.user = makeUser("VET");
    mockApiGet.mockImplementation((url: string) => {
      if (url === "/api/consultations/consult-1") {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              id: "consult-1",
              clientId: "tutor-1",
              vetId: "vet-user-1",
              petId: "milo",
              status: "ACTIVE",
              reason: "Control dermatológico",
              pet: {
                id: "milo",
                name: "Milo",
                species: "DOG",
                breed: "Caniche",
              },
              client: {
                id: "tutor-1",
                firstName: "Lucía",
                lastName: "Gómez",
              },
              vet: {
                id: "vet-user-1",
                firstName: "Martín",
                lastName: "Rojas",
              },
            },
          },
        });
      }
      if (url === "/api/consultations/consult-1/messages") {
        return Promise.resolve({ data: { success: true, data: [] } });
      }
      return Promise.resolve({ data: { success: true, data: [] } });
    });

    const { container } = renderCallRoom();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Chat$/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Chat$/i }));

    expect(container.querySelector(".wa-chat-pane__header")).toBeInTheDocument();
    expect(screen.getByTestId("clinical-security-note")).toBeInTheDocument();

    const quickBtn = screen.getByRole("button", { name: "Respuestas rápidas" });
    fireEvent.click(quickBtn);

    const firstQuickItem = screen.getByRole("menuitem", {
      name: /Voy a revisar la información de la ficha/i,
    });
    fireEvent.click(firstQuickItem);

    const input = screen.getByTestId("chat-message-input") as HTMLInputElement;
    expect(input.value).toContain("Voy a revisar la información de la ficha");
  });
});
