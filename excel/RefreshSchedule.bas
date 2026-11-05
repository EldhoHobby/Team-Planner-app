Attribute VB_Name = "TeamPlanner"
' Team Planner - "Load schedule" button for Team Planner Schedule.xlsm.
' Pulls the latest scheduled + tentative jobs from the read-only reporting
' views (login excel_reader). Server name comes from cell B2.
Option Explicit

Public Sub RefreshSchedule()
    Dim ws As Worksheet
    Dim server As String, f As String
    Set ws = ThisWorkbook.Worksheets("Scheduled Jobs")

    server = Replace(Trim$(CStr(ThisWorkbook.Names("PlannerServerCell").RefersToRange.Value)), """", "")
    If server = "" Then server = "localhost"

    ' Point the query at the server typed in B2 (rewritten only when it changed,
    ' so Excel does not re-ask for the password on every click).
    f = """" & server & """ meta [IsParameterQuery=true, Type=""Text"", IsParameterQueryRequired=true]"
    If ThisWorkbook.Queries("PlannerServer").Formula <> f Then
        ThisWorkbook.Queries("PlannerServer").Formula = f
    End If

    On Error GoTo Failed
    Application.Cursor = xlWait
    Application.StatusBar = "Loading schedule from " & server & "..."
    ws.ListObjects("ScheduledJobs").QueryTable.Refresh BackgroundQuery:=False
    ThisWorkbook.Names("LastRefreshedCell").RefersToRange.Value = Now
    Application.StatusBar = False
    Application.Cursor = xlDefault
    Exit Sub

Failed:
    Application.StatusBar = False
    Application.Cursor = xlDefault
    MsgBox "Could not load the schedule from " & server & ":" & vbCrLf & vbCrLf & _
           Err.Description, vbExclamation, "Team Planner"
End Sub
