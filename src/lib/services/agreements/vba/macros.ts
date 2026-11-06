// The monthly workbook's macros (Central-style): generated from the workbook layout so the VBA
// can't drift from the sheets. ThisWorkbook only holds the workbook-level events; everything
// else is in the standard module "Agreements". Keep the source Windows-1252 (no curly quotes,
// dashes or ellipses) — ovba.ts refuses anything else.

/** Column numbers (1 = A) and rows the macros need. */
export interface MacroLayout {
  title: string;
  sheets: { pricing: string; proposals: string; customers: string; view: string };
  pricing: {
    year: number; agreement: number; price: number; status: number; end: number; so: number; signed: number;
    notes: number; created: number; del: number; id: number; lastCol: number; lastRow: number;
    /** Input columns cleared when a never-imported row is taken off. */
    clear: number[];
  };
  proposals: { so: number; year: number; status: number; end: number; signed: number; id: number; lastRow: number };
  customers: { name: number; so: number; lastRow: number };
  sheet: {
    year1: number; end: number; pct: number; head: number; price: number;
    fPct: number; fPrice: number; fEnd: number; agFirst: number; agLast: number; total: number;
  };
  buttons: { newProposal: string; markSigned: string; editPricing: string };
  /** Screen-only bits blanked while a customer sheet prints: the button ranges and hint cells. */
  print: { buttons: string[]; hints: string[] };
}

const vbaString = (s: string) => `"${s.replace(/"/g, '""')}"`;

export const THIS_WORKBOOK_CODE = `Option Explicit

' Service agreements workbook - every sheet's edits and link clicks go to the Agreements module.

Private Sub Workbook_SheetChange(ByVal Sh As Object, ByVal Target As Range)
    If Agreements.Busy Then Exit Sub
    If Agreements.IsCustomerSheet(Sh) Then Agreements.CellChanged Sh, Target
End Sub

Private Sub Workbook_SheetFollowHyperlink(ByVal Sh As Object, ByVal Target As Hyperlink)
    If Agreements.Busy Then Exit Sub
    Agreements.LinkClicked Sh, Target
End Sub

Private Sub Workbook_BeforePrint(Cancel As Boolean)
    Agreements.PrepareForPrint
End Sub
`;

export function agreementsModuleCode(L: MacroLayout): string {
  const P = L.pricing, X = L.proposals, C = L.customers, R = L.sheet;
  return `Option Explicit

' Service agreements workbook macros, written by Team Planner with each export (changes made here
' are lost on the next export). They work like the Central workbook's Customer View:
'  - typing a price, an Increase % or the End date in a customer sheet's yellow cells saves it to
'    the Pricing sheet straight away (Status "Proposed"); the cell then shows its formula again
'  - New Proposal / Mark Signed / Edit in Pricing (the grey buttons) are links handled below
'  - on Customer View, typing part of a name or an SO # in B2 picks the customer
' Everything is brought into the app by the normal import (Agreements > Settings > Monthly workbook).

Private Const SH_PRICING As String = ${vbaString(L.sheets.pricing)}
Private Const SH_PROPOSALS As String = ${vbaString(L.sheets.proposals)}
Private Const SH_CUSTOMERS As String = ${vbaString(L.sheets.customers)}
Private Const SH_VIEW As String = ${vbaString(L.sheets.view)}
Private Const CV_TITLE As String = ${vbaString(L.title)}
Private Const BTN_NEW As String = ${vbaString(L.buttons.newProposal)}
Private Const BTN_SIGN As String = ${vbaString(L.buttons.markSigned)}
Private Const BTN_PRICING As String = ${vbaString(L.buttons.editPricing)}

' Pricing sheet columns
Private Const P_YEAR As Long = ${P.year}
Private Const P_AGR As Long = ${P.agreement}
Private Const P_PRICE As Long = ${P.price}
Private Const P_STATUS As Long = ${P.status}
Private Const P_END As Long = ${P.end}
Private Const P_SO As Long = ${P.so}
Private Const P_SIGNED As Long = ${P.signed}
Private Const P_NOTES As Long = ${P.notes}
Private Const P_CREATED As Long = ${P.created}
Private Const P_DEL As Long = ${P.del}
Private Const P_ID As Long = ${P.id}
Private Const P_LASTCOL As Long = ${P.lastCol}
Private Const P_LAST As Long = ${P.lastRow}

' Proposals sheet columns
Private Const X_SO As Long = ${X.so}
Private Const X_YEAR As Long = ${X.year}
Private Const X_STATUS As Long = ${X.status}
Private Const X_END As Long = ${X.end}
Private Const X_SIGNED As Long = ${X.signed}
Private Const X_ID As Long = ${X.id}
Private Const X_LAST As Long = ${X.lastRow}

' Customers sheet columns
Private Const C_NAME As Long = ${C.name}
Private Const C_SO As Long = ${C.so}
Private Const C_LAST As Long = ${C.lastRow}

' Customer sheet rows / columns
Private Const R_YEAR1 As Long = ${R.year1}
Private Const R_END As Long = ${R.end}
Private Const R_PCT As Long = ${R.pct}
Private Const R_HEAD As Long = ${R.head}
Private Const R_PRICE As Long = ${R.price}
Private Const R_FPCT As Long = ${R.fPct}
Private Const R_FPRICE As Long = ${R.fPrice}
Private Const R_FEND As Long = ${R.fEnd}
Private Const AG_FIRST As Long = ${R.agFirst}
Private Const AG_LAST As Long = ${R.agLast}
Private Const COL_TOTAL As Long = ${R.total}

Public Busy As Boolean
Private NewEnd As Variant
Private SavedCalc As Long
Private PrintSheet As Worksheet
Private PrintValues As Variant

' ---------- helpers ----------

Private Function Txt(ByVal v As Variant) As String
    If IsError(v) Then
        Txt = ""
    Else
        Txt = Trim$(CStr(v))
    End If
End Function

Private Function IsNumber(ByVal v As Variant) As Boolean
    Select Case VarType(v)
        Case vbInteger, vbLong, vbSingle, vbDouble, vbCurrency, vbDecimal
            IsNumber = True
    End Select
End Function

Private Function RoundPrice(ByVal x As Double) As Double
    RoundPrice = Int(x + 0.5)
End Function

Private Function Pricing() As Worksheet
    Set Pricing = ThisWorkbook.Worksheets(SH_PRICING)
End Function

Private Function PricingData() As Variant
    Dim ws As Worksheet
    Set ws = Pricing()
    PricingData = ws.Range(ws.Cells(1, 1), ws.Cells(P_LAST, P_LASTCOL)).Value
End Function

Private Function SheetSO(ByVal ws As Worksheet) As String
    SheetSO = UCase$(Txt(ws.Range("B4").Value))
End Function

Private Function ProposalYear(ByVal ws As Worksheet) As Long
    Dim v As Variant
    v = ws.Cells(R_PRICE, 1).Value
    If IsNumber(v) Then ProposalYear = CLng(v)
End Function

Private Function SameRow(ByRef d As Variant, ByVal r As Long, ByVal so As String, ByVal yr As Long) As Boolean
    If UCase$(Txt(d(r, P_SO))) = so Then SameRow = (Txt(d(r, P_YEAR)) = CStr(yr))
End Function

Private Function IsDeleted(ByRef d As Variant, ByVal r As Long) As Boolean
    IsDeleted = (UCase$(Txt(d(r, P_DEL))) = "DELETE")
End Function

Private Sub BeginWork()
    Busy = True
    Application.EnableEvents = False
    Application.ScreenUpdating = False
    SavedCalc = Application.Calculation
    Application.Calculation = xlCalculationManual
End Sub

Private Sub EndWork()
    On Error Resume Next
    Application.Calculation = SavedCalc
    Application.ScreenUpdating = True
    Application.EnableEvents = True
    Busy = False
End Sub

' ---------- entry points (called from ThisWorkbook) ----------

Public Function IsCustomerSheet(ByVal Sh As Object) As Boolean
    On Error GoTo nope
    If TypeName(Sh) <> "Worksheet" Then Exit Function
    If Txt(Sh.Range("A1").Value) <> CV_TITLE Then Exit Function
    IsCustomerSheet = (Txt(Sh.Cells(R_END, 1).Value) = "End date")
nope:
End Function

' A yellow cell (price, Increase % or End date) or the Customer View picker changed.
Public Sub CellChanged(ByVal ws As Worksheet, ByVal Target As Range)
    Dim area As Range, cell As Range, so As String, yr As Long, agr As String
    Dim v As Variant, lastPrice As Variant, msg As String
    If Busy Then Exit Sub
    If ws.Name = SH_VIEW Then
        If Not Intersect(Target, ws.Range("B2")) Is Nothing Then
            PickCustomer ws
            Exit Sub
        End If
    End If
    Set area = Intersect(Target, Union(ws.Range(ws.Cells(R_PCT, AG_FIRST), ws.Cells(R_PCT, AG_LAST)), _
        ws.Range(ws.Cells(R_PRICE, AG_FIRST), ws.Cells(R_PRICE, AG_LAST)), _
        ws.Range(ws.Cells(R_END, 2), ws.Cells(R_END, 3))))
    If area Is Nothing Then Exit Sub
    so = SheetSO(ws)
    yr = ProposalYear(ws)
    BeginWork
    On Error GoTo failed
    If so = "" Or yr = 0 Then
        msg = "This customer has no signed year yet, so there is no proposal year to price." & vbCrLf & _
              "Add its agreements on the Pricing sheet instead." & vbCrLf
    Else
        NewEnd = ws.Cells(R_END, 2).Value
        ' The first change starts the proposal from every price the row shows (as New Proposal would).
        If CountOpen(so, yr) = 0 Then msg = msg & CreateFromSheet(ws, so, yr)
        For Each cell In area.Cells
            If cell.Row = R_END Then
                v = ws.Cells(R_END, 2).Value
                If IsDate(v) Then SetProposalEnd so, yr, CDate(v)
            Else
                agr = Txt(ws.Cells(R_HEAD, cell.Column).Value)
                v = cell.Value
                If cell.Row = R_PCT Then
                    lastPrice = ws.Cells(R_YEAR1, cell.Column).Value
                    If IsNumber(v) And IsNumber(lastPrice) Then
                        If CDbl(lastPrice) <> 0 Then msg = msg & SetPrice(so, yr, agr, RoundPrice(CDbl(lastPrice) * (1 + CDbl(v))), ws.Name)
                    ElseIf Not IsEmpty(v) Then
                        msg = msg & "Increase % for " & agr & ": type a percentage (last year's price is needed)." & vbCrLf
                    End If
                ElseIf IsEmpty(v) Then
                    msg = msg & SetPrice(so, yr, agr, 0, ws.Name)
                ElseIf IsNumber(v) Then
                    msg = msg & SetPrice(so, yr, agr, CDbl(v), ws.Name)
                Else
                    msg = msg & """" & Txt(v) & """ is not a price (" & agr & ")." & vbCrLf
                End If
            End If
        Next cell
    End If
done:
    On Error Resume Next
    RestoreFormulas ws
    EndWork
    On Error GoTo 0
    If msg <> "" Then MsgBox msg, vbExclamation, "Service agreements"
    Exit Sub
failed:
    msg = msg & "Couldn't save that change: " & Err.Description
    Resume done
End Sub

' One of the grey buttons (a hyperlink) was clicked.
Public Sub LinkClicked(ByVal Sh As Object, ByVal link As Hyperlink)
    Dim ws As Worksheet, cap As String
    If Not IsCustomerSheet(Sh) Then Exit Sub
    Set ws = Sh
    cap = Txt(link.Range.Cells(1, 1).Value)
    If cap = BTN_NEW Then
        NewProposal ws
    ElseIf cap = BTN_SIGN Then
        MarkSigned ws
    ElseIf cap = BTN_PRICING Then
        ShowInPricing SheetSO(ws)
    End If
End Sub

' ---------- printing ----------

' Before a customer sheet prints: blank the screen-only buttons and hints; put them back once
' Excel is idle again (after the print / preview).
Public Sub PrepareForPrint()
    Dim ws As Worksheet, addrs As Variant, rng As Variant, i As Long
    If Not IsCustomerSheet(ActiveSheet) Then Exit Sub
    If Not PrintSheet Is Nothing Then RestoreAfterPrint
    Set ws = ActiveSheet
    addrs = Array(${[...L.print.buttons.map((b) => b.split(":")[0]!), ...L.print.hints].map(vbaString).join(", ")})
    ReDim PrintValues(LBound(addrs) To UBound(addrs))
    Busy = True
    Application.EnableEvents = False
    On Error Resume Next
    For i = LBound(addrs) To UBound(addrs)
        PrintValues(i) = ws.Range(addrs(i)).Value
        ws.Range(addrs(i)).Value = ""
    Next i
    For Each rng In Array(${L.print.buttons.map(vbaString).join(", ")})
        ws.Range(rng).Borders.LineStyle = xlNone
        ws.Range(rng).Interior.Pattern = xlNone
    Next rng
    Set PrintSheet = ws
    Application.EnableEvents = True
    Busy = False
    Application.OnTime Now, "'" & ThisWorkbook.Name & "'!Agreements.RestoreAfterPrint"
End Sub

Public Sub RestoreAfterPrint()
    Dim ws As Worksheet, addrs As Variant, rng As Variant, i As Long
    If PrintSheet Is Nothing Then Exit Sub
    Set ws = PrintSheet
    Set PrintSheet = Nothing
    Busy = True
    Application.EnableEvents = False
    On Error Resume Next
    addrs = Array(${[...L.print.buttons.map((b) => b.split(":")[0]!), ...L.print.hints].map(vbaString).join(", ")})
    For i = LBound(addrs) To UBound(addrs)
        ws.Range(addrs(i)).Value = PrintValues(i)
    Next i
    For Each rng In Array(${L.print.buttons.map(vbaString).join(", ")})
        With ws.Range(rng)
            .Interior.Color = RGB(240, 240, 240)
            .Borders(xlEdgeTop).LineStyle = xlContinuous
            .Borders(xlEdgeTop).Weight = xlThin
            .Borders(xlEdgeTop).Color = RGB(166, 166, 166)
            .Borders(xlEdgeLeft).LineStyle = xlContinuous
            .Borders(xlEdgeLeft).Weight = xlThin
            .Borders(xlEdgeLeft).Color = RGB(166, 166, 166)
            .Borders(xlEdgeBottom).LineStyle = xlContinuous
            .Borders(xlEdgeBottom).Weight = xlMedium
            .Borders(xlEdgeBottom).Color = RGB(128, 128, 128)
            .Borders(xlEdgeRight).LineStyle = xlContinuous
            .Borders(xlEdgeRight).Weight = xlMedium
            .Borders(xlEdgeRight).Color = RGB(128, 128, 128)
        End With
    Next rng
    Application.EnableEvents = True
    Busy = False
End Sub

' ---------- buttons ----------

Public Sub NewProposal(ByVal ws As Worksheet)
    Dim so As String, yr As Long, nm As String, c As Long, n As Long, total As Double, v As Variant, msg As String
    so = SheetSO(ws)
    yr = ProposalYear(ws)
    nm = Txt(ws.Range("B2").Value)
    If so = "" Or yr = 0 Then
        MsgBox "No signed prices found for " & nm & ".", vbExclamation, "New proposal"
        Exit Sub
    End If
    If CountOpen(so, yr) > 0 Then
        MsgBox nm & " already has a " & yr & " proposal." & vbCrLf & _
               "Change the yellow prices, or click Edit in Pricing.", vbInformation, "New proposal"
        Exit Sub
    End If
    For c = AG_FIRST To AG_LAST
        v = ws.Cells(R_PRICE, c).Value
        If IsNumber(v) Then
            If CDbl(v) > 0 Then
                n = n + 1
                total = total + CDbl(v)
            End If
        End If
    Next c
    If n = 0 Then
        MsgBox "There are no prices to propose. Type them in the yellow cells.", vbInformation, "New proposal"
        Exit Sub
    End If
    If MsgBox("Create the " & yr & " proposal for " & nm & " from the prices shown?" & vbCrLf & _
              "(" & n & " agreements, " & Format$(total, "$#,##0") & " - worked out from the Settings sheet)", _
              vbYesNo + vbQuestion, "New proposal") <> vbYes Then Exit Sub
    BeginWork
    On Error GoTo failed
    NewEnd = ws.Cells(R_END, 2).Value
    msg = CreateFromSheet(ws, so, yr)
done:
    On Error Resume Next
    EndWork
    On Error GoTo 0
    If msg <> "" Then
        MsgBox msg, vbExclamation, "New proposal"
    Else
        MsgBox yr & " proposal created: " & Format$(total, "$#,##0") & vbCrLf & _
               "Adjust any % or price in the yellow cells, then click Mark Signed when the customer signs." & vbCrLf & _
               "It goes into the app when this file is imported.", vbInformation, "New proposal"
    End If
    Exit Sub
failed:
    msg = msg & "Couldn't create the proposal: " & Err.Description
    Resume done
End Sub

Public Sub MarkSigned(ByVal ws As Worksheet)
    Dim so As String, yr As Long, nm As String, d As Variant, r As Long, n As Long, total As Double
    Dim pr As Worksheet, xs As Worksheet, e As Variant, msg As String
    so = SheetSO(ws)
    yr = ProposalYear(ws)
    nm = Txt(ws.Range("B2").Value)
    If so = "" Or yr = 0 Then
        MsgBox nm & " has no open proposal. Click New Proposal first.", vbInformation, "Mark signed"
        Exit Sub
    End If
    d = PricingData()
    For r = 2 To P_LAST
        If SameRow(d, r, so, yr) Then
            If Txt(d(r, P_STATUS)) = "Proposed" And Not IsDeleted(d, r) Then
                n = n + 1
                If IsNumber(d(r, P_PRICE)) Then total = total + CDbl(d(r, P_PRICE))
            End If
        End If
    Next r
    If n = 0 Then
        MsgBox nm & " has no open " & yr & " proposal. Click New Proposal first.", vbInformation, "Mark signed"
        Exit Sub
    End If
    If MsgBox("Mark the " & yr & " proposal for " & nm & " as SIGNED?" & vbCrLf & vbCrLf & _
              n & " agreements, total " & Format$(total, "$#,##0") & vbCrLf & _
              "Signed date: " & Format$(Date, "m/d/yyyy") & vbCrLf & vbCrLf & _
              "Tip: if only some agreements were signed, clear the others' prices first.", _
              vbYesNo + vbQuestion, "Mark signed") <> vbYes Then Exit Sub
    BeginWork
    On Error GoTo failed
    Set pr = Pricing()
    e = ws.Cells(R_END, 2).Value
    For r = 2 To P_LAST
        If SameRow(d, r, so, yr) Then
            If Txt(d(r, P_STATUS)) = "Proposed" And Not IsDeleted(d, r) Then
                pr.Cells(r, P_STATUS).Value = "Signed"
                pr.Cells(r, P_SIGNED).Value = Date
                If Not IsDate(d(r, P_END)) And IsDate(e) Then pr.Cells(r, P_END).Value = CDate(e)
            End If
        End If
    Next r
    Set xs = ThisWorkbook.Worksheets(SH_PROPOSALS)
    r = ProposalRow(so, yr, True)
    If r = 0 Then r = ProposalRow(so, yr, False)
    If r = 0 Then
        r = FreeProposalRow()
        xs.Cells(r, X_SO).Value = so
        xs.Cells(r, X_YEAR).Value = yr
        If IsDate(e) Then xs.Cells(r, X_END).Value = CDate(e)
    End If
    xs.Cells(r, X_STATUS).Value = "Signed"
    xs.Cells(r, X_SIGNED).Value = Date
done:
    On Error Resume Next
    EndWork
    On Error GoTo 0
    If msg <> "" Then
        MsgBox msg, vbExclamation, "Mark signed"
    Else
        MsgBox nm & " " & yr & " marked signed." & vbCrLf & "It goes into the app when this file is imported.", vbInformation, "Mark signed"
    End If
    Exit Sub
failed:
    msg = "Couldn't mark it signed: " & Err.Description
    Resume done
End Sub

Public Sub ShowInPricing(ByVal so As String)
    Dim ws As Worksheet, d As Variant, r As Long, last As Long
    Set ws = Pricing()
    ws.Activate
    If ws.AutoFilterMode Then ws.AutoFilterMode = False
    d = PricingData()
    last = 2
    For r = 2 To P_LAST
        If Txt(d(r, P_SO)) <> "" Or Txt(d(r, P_YEAR)) <> "" Then last = r
    Next r
    If so = "" Then
        ws.Range(ws.Cells(1, 1), ws.Cells(last, P_LASTCOL)).AutoFilter
    Else
        ws.Range(ws.Cells(1, 1), ws.Cells(last, P_LASTCOL)).AutoFilter Field:=P_SO, Criteria1:=so
    End If
End Sub

' ---------- Pricing rows ----------

' Row of a Pricing line for SO / year / agreement / status (also one marked DELETE), 0 = none.
Private Function FindRow(ByVal so As String, ByVal yr As Long, ByVal agr As String, ByVal status As String) As Long
    Dim d As Variant, r As Long
    d = PricingData()
    For r = 2 To P_LAST
        If SameRow(d, r, so, yr) Then
            If Txt(d(r, P_AGR)) = agr And Txt(d(r, P_STATUS)) = status Then
                FindRow = r
                Exit Function
            End If
        End If
    Next r
End Function

' Proposed lines still on the proposal (not marked DELETE).
Private Function CountOpen(ByVal so As String, ByVal yr As Long) As Long
    Dim d As Variant, r As Long, n As Long
    d = PricingData()
    For r = 2 To P_LAST
        If SameRow(d, r, so, yr) Then
            If Txt(d(r, P_STATUS)) = "Proposed" And Not IsDeleted(d, r) Then n = n + 1
        End If
    Next r
    CountOpen = n
End Function

Private Function SetPrice(ByVal so As String, ByVal yr As Long, ByVal agr As String, ByVal price As Double, ByVal src As String) As String
    Dim ws As Worksheet, r As Long
    If agr = "" Then Exit Function
    Set ws = Pricing()
    If FindRow(so, yr, agr, "Signed") > 0 Then
        SetPrice = agr & " " & yr & " is already signed - change it on the Pricing sheet if it really needs to change." & vbCrLf
        Exit Function
    End If
    r = FindRow(so, yr, agr, "Proposed")
    If price <= 0 Then
        If r > 0 Then DropRow r
        Exit Function
    End If
    If r = 0 Then r = AddRow(so, yr, agr, "Added on the " & src & " sheet " & Format$(Date, "m/d/yyyy"))
    ws.Cells(r, P_PRICE).Value = RoundPrice(price)
    If UCase$(Txt(ws.Cells(r, P_DEL).Value)) = "DELETE" Then ws.Cells(r, P_DEL).ClearContents
End Function

' Take a line off: an imported line is marked DELETE (the import removes it), a new one is cleared.
Private Sub DropRow(ByVal r As Long)
    Dim ws As Worksheet, c As Variant
    Set ws = Pricing()
    If Txt(ws.Cells(r, P_ID).Value) <> "" Then
        ws.Cells(r, P_PRICE).Value = 0
        ws.Cells(r, P_DEL).Value = "DELETE"
    Else
        For Each c In Array(${P.clear.join(", ")})
            ws.Cells(r, c).ClearContents
        Next c
    End If
End Sub

Private Function AddRow(ByVal so As String, ByVal yr As Long, ByVal agr As String, ByVal note As String) As Long
    Dim ws As Worksheet, d As Variant, r As Long, found As Long, e As Variant
    Set ws = Pricing()
    d = PricingData()
    For r = 2 To P_LAST
        If Txt(d(r, P_YEAR)) = "" And Txt(d(r, P_AGR)) = "" And Txt(d(r, P_SO)) = "" Then
            found = r
            Exit For
        End If
    Next r
    If found = 0 Then Err.Raise vbObjectError + 513, , "The Pricing sheet is full - import this file into the app and export a fresh one."
    e = ProposalEnd(so, yr)
    r = found
    AddRow = found
    ws.Cells(r, P_SO).Value = so
    ws.Cells(r, P_YEAR).Value = yr
    ws.Cells(r, P_AGR).Value = agr
    ws.Cells(r, P_STATUS).Value = "Proposed"
    If IsDate(e) Then ws.Cells(r, P_END).Value = CDate(e)
    ws.Cells(r, P_NOTES).Value = note
    ws.Cells(r, P_CREATED).Value = Date
End Function

' The proposal's end date: an existing Proposed row's, else the one on the customer sheet.
Private Function ProposalEnd(ByVal so As String, ByVal yr As Long) As Variant
    Dim d As Variant, r As Long
    d = PricingData()
    For r = 2 To P_LAST
        If SameRow(d, r, so, yr) Then
            If Txt(d(r, P_STATUS)) = "Proposed" And IsDate(d(r, P_END)) Then
                ProposalEnd = d(r, P_END)
                Exit Function
            End If
        End If
    Next r
    If IsDate(NewEnd) Then ProposalEnd = NewEnd
End Function

Private Function CreateFromSheet(ByVal ws As Worksheet, ByVal so As String, ByVal yr As Long) As String
    Dim c As Long, v As Variant, msg As String
    For c = AG_FIRST To AG_LAST
        v = ws.Cells(R_PRICE, c).Value
        If IsNumber(v) Then
            If CDbl(v) > 0 Then msg = msg & SetPrice(so, yr, Txt(ws.Cells(R_HEAD, c).Value), CDbl(v), ws.Name)
        End If
    Next c
    CreateFromSheet = msg
End Function

Private Sub SetProposalEnd(ByVal so As String, ByVal yr As Long, ByVal endDate As Date)
    Dim ws As Worksheet, d As Variant, r As Long
    Set ws = Pricing()
    d = PricingData()
    For r = 2 To P_LAST
        If SameRow(d, r, so, yr) Then
            If Txt(d(r, P_STATUS)) = "Proposed" Then ws.Cells(r, P_END).Value = endDate
        End If
    Next r
    r = ProposalRow(so, yr, True)
    If r > 0 Then ThisWorkbook.Worksheets(SH_PROPOSALS).Cells(r, X_END).Value = endDate
End Sub

' ---------- Proposals rows ----------

' openOnly: a Draft / Sent row (or a new row with no status); else a row with no ID yet.
Private Function ProposalRow(ByVal so As String, ByVal yr As Long, ByVal openOnly As Boolean) As Long
    Dim xs As Worksheet, d As Variant, r As Long, st As String
    Set xs = ThisWorkbook.Worksheets(SH_PROPOSALS)
    d = xs.Range(xs.Cells(1, 1), xs.Cells(X_LAST, X_ID)).Value
    For r = 2 To X_LAST
        If UCase$(Txt(d(r, X_SO))) = so And Txt(d(r, X_YEAR)) = CStr(yr) Then
            st = Txt(d(r, X_STATUS))
            If openOnly Then
                If st = "Draft" Or st = "Sent" Or st = "" Then
                    ProposalRow = r
                    Exit Function
                End If
            ElseIf Txt(d(r, X_ID)) = "" Then
                ProposalRow = r
                Exit Function
            End If
        End If
    Next r
End Function

Private Function FreeProposalRow() As Long
    Dim xs As Worksheet, d As Variant, r As Long
    Set xs = ThisWorkbook.Worksheets(SH_PROPOSALS)
    d = xs.Range(xs.Cells(1, 1), xs.Cells(X_LAST, X_ID)).Value
    For r = 2 To X_LAST
        If Txt(d(r, X_SO)) = "" And Txt(d(r, X_YEAR)) = "" And Txt(d(r, X_ID)) = "" Then
            FreeProposalRow = r
            Exit Function
        End If
    Next r
    Err.Raise vbObjectError + 514, , "The Proposals sheet is full - import this file into the app and export a fresh one."
End Function

' ---------- customer sheet ----------

' Put the formulas back in the yellow cells (their text is kept in hidden rows).
Private Sub RestoreFormulas(ByVal ws As Worksheet)
    Dim c As Long
    For c = AG_FIRST To AG_LAST
        If Not ws.Cells(R_PCT, c).HasFormula Then ws.Cells(R_PCT, c).Formula = "=" & ws.Cells(R_FPCT, c).Value
        If Not ws.Cells(R_PRICE, c).HasFormula Then ws.Cells(R_PRICE, c).Formula = "=" & ws.Cells(R_FPRICE, c).Value
    Next c
    If Not ws.Cells(R_END, 2).HasFormula Then ws.Cells(R_END, 2).Formula = "=" & ws.Cells(R_FEND, 2).Value
End Sub

' Customer View: accepts the exact name, an SO #, or part of a name (a name starting with it first).
Private Sub PickCustomer(ByVal ws As Worksheet)
    Dim typed As String, d As Variant, r As Long, nm As String, best As String, others As String
    Dim n As Long, exact As String, starts As Boolean, bestStarts As Boolean
    typed = Txt(ws.Range("B2").Value)
    If typed = "" Then Exit Sub
    With ThisWorkbook.Worksheets(SH_CUSTOMERS)
        d = .Range(.Cells(1, 1), .Cells(C_LAST, C_SO)).Value
    End With
    For r = 2 To C_LAST
        nm = Txt(d(r, C_NAME))
        If nm <> "" Then
            If UCase$(nm) = UCase$(typed) Or UCase$(Txt(d(r, C_SO))) = UCase$(typed) Then
                exact = nm
                Exit For
            ElseIf InStr(1, nm, typed, vbTextCompare) > 0 Then
                n = n + 1
                starts = (UCase$(Left$(nm, Len(typed))) = UCase$(typed))
                If best = "" Or (starts And Not bestStarts) Then
                    If best <> "" Then others = others & vbCrLf & "  " & best
                    best = nm
                    bestStarts = starts
                Else
                    others = others & vbCrLf & "  " & nm
                End If
            End If
        End If
    Next r
    If exact <> "" Then
        best = exact
        n = 1
    End If
    If best = "" Then
        MsgBox "No customer matches """ & typed & """." & vbCrLf & "Check the spelling or pick from the list.", vbExclamation, "Customer View"
        Exit Sub
    End If
    Busy = True
    Application.EnableEvents = False
    On Error Resume Next
    ws.Range("B2").Value = best
    Application.EnableEvents = True
    Busy = False
    On Error GoTo 0
    If n > 1 Then MsgBox "Showing " & best & "." & vbCrLf & vbCrLf & "Other matches:" & others, vbInformation, "Customer View"
End Sub
`;
}
