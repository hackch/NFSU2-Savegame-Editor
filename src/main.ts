import { EditorController } from './controller/editor-controller.js';
import { nfsuFileChange } from './controller/file-change.js';
import { nfsuRangeChange } from './controller/range-change.js';

angular
  .module('nfsu2Editor', [])
  .directive('nfsuFileChange', nfsuFileChange)
  .directive('nfsuRangeChange', nfsuRangeChange)
  .controller('EditorController', ['$scope', EditorController]);
