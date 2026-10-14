// 动态报名字段渲染器：同一个组件负责全部 8 种字段类型。
// 注意：不要自定义名为 triggerEvent 的方法，那会覆盖组件框架提供的能力。
Component({
  properties: {
    field: { type: null, value: {} },
    value: { type: null, value: '' },
    error: { type: String, value: '' },
  },

  data: {
    // 多选字段的 value 归一化成数组，避免模板里对字符串调用 indexOf。
    checked: [],
    // 下拉选择用下标回传，便于 picker 在当前值上定位。
    selectedIndex: 0,
  },

  observers: {
    'field, value': function (field, value) {
      const list = Array.isArray(value) ? value : [];
      const options = (field && field.options) || [];
      this.setData({
        checked: list,
        selectedIndex: options.indexOf(value) > -1 ? options.indexOf(value) : 0,
      });
    },
  },

  methods: {
    emit(value) {
      this.triggerEvent('change', { key: this.data.field.key, value: value });
    },
    onInput(e) {
      this.emit(e.detail.value);
    },
    onRadioTap(e) {
      this.emit(e.currentTarget.dataset.value);
    },
    onCheckboxChange(e) {
      this.emit(e.detail.value);
    },
    onSelectChange(e) {
      const options = (this.data.field && this.data.field.options) || [];
      this.emit(options[Number(e.detail.value)] || '');
    },
  },
});
