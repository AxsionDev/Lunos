using System;
using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using System.Threading;
using Lunos.VisualStudio.Commands;
using Lunos.VisualStudio.ToolWindow;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace Lunos.VisualStudio
{
    /// <summary>
    /// The Lunos package (XCOD-333): registers the tool window, the commands (LunosPackage.vsct) and the
    /// options page, and owns the connection to the local Lunos server (LunosService).
    /// </summary>
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid(PackageGuid)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideToolWindow(typeof(LunosToolWindow), Style = VsDockStyle.Tabbed, Window = "DocumentWell", Orientation = ToolWindowOrientation.Right)]
    [ProvideOptionPage(typeof(LunosOptions), "Lunos", "General", 0, 0, true)]
    public sealed class LunosPackage : AsyncPackage
    {
        public const string PackageGuid = "6b6c0f4e-3f0a-4a4b-9d2a-0c3f3c3e0333";
        public static readonly Guid CommandSet = new Guid("a3e3f9a1-7c0d-4b8e-8f1e-2d4c5b6a0333");

        public LunosService Lunos { get; private set; } = null!;

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            Lunos = new LunosService(this);
            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            var commands = (OleMenuCommandService)(await GetServiceAsync(typeof(IMenuCommandService)))!;
            LunosCommands.Register(this, commands);
        }

        public LunosOptions Options => (LunosOptions)GetDialogPage(typeof(LunosOptions));

        protected override void Dispose(bool disposing)
        {
            if (disposing) Lunos?.Dispose();
            base.Dispose(disposing);
        }
    }

    /// <summary>Tools | Options | Lunos: the path to the <c>lunos</c> executable when it isn't on PATH.</summary>
    public sealed class LunosOptions : DialogPage
    {
        [System.ComponentModel.Category("Lunos")]
        [System.ComponentModel.DisplayName("Path to lunos")]
        [System.ComponentModel.Description("The lunos executable (lunos.cmd for an npm install). Empty: the first lunos on PATH.")]
        public string LunosPath { get; set; } = "";
    }
}
