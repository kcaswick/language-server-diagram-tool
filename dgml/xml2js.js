import { readFile, writeFile } from "fs";
import { Parser } from "xml2js";

const parser = new Parser();
readFile("../../../Projects-API/Model.Miron.Projects/CodeMap1.dgml", function (err, data) {
  if (err) throw err;
  console.log(data?.length);
  parser.parseString(data, function (err, result) {
    if (err) throw err;
    console.dir(result);
    if (result) {
      writeFile("xml2js.json", JSON.stringify(result, null, 2), function (err) {
        if (err) console.log(err);
        console.log("Successfully Written to File.");
      });
    }

    console.log("Done");
  });
});
