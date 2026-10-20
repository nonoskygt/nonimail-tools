; NoniMail Cleaner — verificación de RAM en el instalador (antes de copiar nada).
;   < 3,5 GB → no se instala (la IA local no entra)
;   3,5 a 7 GB → aviso: se usará el modelo ligero
;   7 GB o más → sin aviso (modelo recomendado)
!include LogicLib.nsh

!macro customInit
  System::Alloc 64
  Pop $0
  System::Call "*$0(i 64)"
  System::Call "kernel32::GlobalMemoryStatusEx(p r0) i.r1"
  System::Call "*$0(i, i, l .r2)"
  System::Free $0
  System::Int64Op $2 / 1048576
  Pop $3
  IntOp $4 $3 + 512
  IntOp $4 $4 / 1024
  ${If} $1 <> 0
    ${If} $3 < 3584
      MessageBox MB_ICONSTOP|MB_OK "NoniMail Cleaner necesita al menos 4 GB de RAM.$\r$\nEste equipo tiene $4 GB." /SD IDOK
      SetErrorLevel 2
      Quit
    ${ElseIf} $3 < 7168
      MessageBox MB_ICONINFORMATION|MB_OK "Este equipo tiene $4 GB de RAM.$\r$\nNoniMail usará el modelo de IA ligero." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
