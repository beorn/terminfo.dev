# #30720 spike: the cost of one UIA read from a fresh process, as the collector would spawn it per
# read. PowerShell-native managed UIA, no compiled helper. Prints the visible line count.
param([Parameter(Mandatory = $true)][int]$WtPid)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$automation = [System.Windows.Automation.AutomationElement]
$byPid = New-Object System.Windows.Automation.PropertyCondition($automation::ProcessIdProperty, $WtPid)
$byClass = New-Object System.Windows.Automation.PropertyCondition($automation::ClassNameProperty, 'TermControl')
$lines = 0
foreach ($top in $automation::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)) {
  foreach ($term in $top.FindAll([System.Windows.Automation.TreeScope]::Descendants, $byClass)) {
    $pattern = $term.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    foreach ($visible in $pattern.GetVisibleRanges()) { $lines += ($visible.GetText(-1) -split "`n").Count }
  }
}
Write-Output $lines
