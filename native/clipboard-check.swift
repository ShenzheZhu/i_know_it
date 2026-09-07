import AppKit
import Foundation
let board = NSPasteboard.general
let token = UUID().uuidString
let marker = NSPasteboard.PasteboardType("com.iknowit.fixture")
let original = (board.pasteboardItems ?? []).map { item in Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }) }
let items = CommandLine.arguments.dropFirst().map { path -> NSPasteboardItem in
 let item = NSPasteboardItem(); item.setString(URL(fileURLWithPath: path).absoluteString, forType: .fileURL); item.setString(token, forType: marker); return item
}
board.clearContents(); guard board.writeObjects(items) else { exit(1) }
let owned = board.changeCount
print("READY"); fflush(stdout)
_ = readLine()
if board.changeCount == owned && board.pasteboardItems?.allSatisfy({ $0.string(forType: marker) == token }) == true {
 let restored = original.map { values -> NSPasteboardItem in let item = NSPasteboardItem(); for (type,data) in values { item.setData(data, forType:type) }; return item }
 board.clearContents(); board.writeObjects(restored)
}
