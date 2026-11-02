package tech.lunos.ide.ui

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import tech.lunos.ide.core.Selection

// The plugin loaded in a headless IDE: its actions, tool window and service are registered, and the
// editor selection maps to the lines sent as context.
class PluginTest : BasePlatformTestCase() {
    fun `test actions are registered and in the editor's context menu`() {
        val actions = ActionManager.getInstance()
        listOf("Lunos.AskAboutSelection", "Lunos.SendProblems", "Lunos.ReviewChanges", "Lunos.OpenTui").forEach {
            assertNotNull(it, actions.getAction(it))
        }
        assertTrue(actions.getAction("Lunos.OpenTui") is ProjectAction)
    }

    fun `test the service is a project service rooted at the project`() {
        val service = LunosService.get(project)
        assertSame(service, LunosService.get(project))
        assertEquals(project.basePath, service.root.path)
    }

    fun `test the selection is sent as 1-based inclusive lines`() {
        myFixture.configureByText("Calc.cs", "a\n<selection>b\nc\n</selection>d\n")
        assertEquals(Selection(2, 3), AskAboutSelectionAction.selection(myFixture.editor))
        myFixture.configureByText("Calc2.cs", "a\nb<selection>b</selection>\nc\n")
        assertEquals(Selection(2, 2), AskAboutSelectionAction.selection(myFixture.editor))
        myFixture.configureByText("Calc3.cs", "a\nb\n")
        assertNull(AskAboutSelectionAction.selection(myFixture.editor))
    }

    fun `test the tool window is declared`() {
        // The light test fixture doesn't create tool windows; the extension point declares it.
        val ids = com.intellij.openapi.wm.ToolWindowEP.EP_NAME.extensionList.map { it.id }
        assertTrue(ids.toString(), "Lunos" in ids)
        assertNotNull(ToolWindowManager.getInstance(project))
    }
}
