from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def test_logged_in_chat_uses_cloud_conversation_api():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")

    assert "listCloudConversations" in source
    assert "appendCloudMessage" in source
    assert "getAuthState().isAuthenticated" in source
    assert "initAIChatStore" in source


def test_conversation_api_uses_authorized_conversation_endpoints():
    source = (ROOT / "src" / "conversationApi.js").read_text(encoding="utf-8")

    for export_name in (
        "listCloudConversations",
        "createCloudConversation",
        "getCloudConversation",
        "updateCloudConversation",
        "appendCloudMessage",
        "deleteCloudConversation",
    ):
        assert f"export async function {export_name}" in source
    assert 'apiRequest("/api/conversations")' in source
    assert 'apiRequest(`/api/conversations/${conversationId}`)' in source
    assert 'apiRequest(`/api/conversations/${conversationId}/messages`' in source


def test_cloud_mode_never_writes_indexeddb_and_only_persists_successful_assistant_replies():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")

    assert "function isCloudConversationMode()" in source
    assert "if (isCloudConversationMode())" in source
    assert "async function appendSubmissionMessage" in source
    assert "await appendCloudMessage(submission.conversationId, { role, content })" in source
    assert "await appendSubmissionMessage(submission, \"user\", question)" in source
    assert "await appendSubmissionMessage(submission, \"assistant\", answer)" in source
    assert "pushAIChatMessage(\"assistant\", `请求失败" not in source


def test_rapid_cloud_submits_acquire_the_pending_lock_before_creating_a_conversation():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    submit = source[source.index("async function submitAIChat()") : source.index("function toggleAIChatPanel()")]

    lock_index = submit.index("state.aiChatPending = true")
    first_cloud_write_index = submit.index('await appendSubmissionMessage(submission, "user", question)')
    assert lock_index < first_cloud_write_index


def test_chat_submission_keeps_its_original_conversation_when_selection_or_auth_changes():
    source = (ROOT / "src" / "main.js").read_text(encoding="utf-8")
    submit = source[source.index("async function submitAIChat()") : source.index("function toggleAIChatPanel()")]
    append = source[source.index("async function appendSubmissionMessage") : source.index("async function getSubmissionMessages")]

    assert "const submission = await createAIChatSubmission()" in submit
    assert "await appendSubmissionMessage(submission, \"user\", question)" in submit
    assert "await appendSubmissionMessage(submission, \"assistant\", answer" in submit
    assert "isCurrentAIChatSubmission(submission)" in submit
    assert "appendCloudMessage(submission.conversationId" in append
    assert "saveAIConversationMessages(submission.conversationId" in append
    assert "state.aiConversationId === submission.conversationId" in append
    assert "if (!isCurrentAIChatSubmission(submission)) return null" in append
    assert "authGeneration" in source
    assert "aiConversationAuthGeneration += 1" in source


def test_conversation_api_normalizes_server_shapes():
    node = Path(r"C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
    script = r'''
      import { readFileSync } from "node:fs";

      const source = readFileSync("./src/conversationApi.js", "utf8").replace(
        'import { apiRequest } from "./apiClient";',
        'globalThis.__calls = []; const apiRequest = async (...args) => { globalThis.__calls.push(args); return { id: "c1", title: "Cloud", pinned: false, archived: false, routeCount: 0, messageCount: 1, lastPreview: "hello", createdAt: "2026-07-25T00:00:00Z", updatedAt: "2026-07-25T00:00:01Z", messages: [{ id: "m1", role: "user", content: "hello", sequence: 1, createdAt: "2026-07-25T00:00:00Z" }] }; };'
      );
      const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      const conversation = await module.getCloudConversation("c1");
      if (conversation.createdAt !== Date.parse("2026-07-25T00:00:00Z")) throw new Error("timestamps were not normalized");
      if (conversation.messages[0].createdAt !== Date.parse("2026-07-25T00:00:00Z")) throw new Error("message timestamps were not normalized");
      await module.appendCloudMessage("c1", { role: "assistant", content: "answer" });
      const [, options] = globalThis.__calls.at(-1);
      if (options.method !== "POST" || !options.body.includes('"role":"assistant"')) throw new Error("message endpoint contract is incorrect");
    '''
    result = subprocess.run(
        [str(node), "--input-type=module", "--eval", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
